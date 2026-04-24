/**
 * zalo-rate-limiter.ts — Per-account rate limiting to prevent Zalo blocks.
 *
 * Backed by Redis when `REDIS_URL`/`REDIS_HOST` is configured (shared state
 * across all backend replicas). Falls back to a per-process in-memory map
 * when Redis is unavailable (single-node deployment, local dev, tests).
 */
import { getRedis } from '../../shared/redis/redis-client.js';
import { logger } from '../../shared/utils/logger.js';

const DAILY_LIMIT = 200;
const BURST_LIMIT = 5;
const BURST_WINDOW_MS = 30_000;
const DAILY_TTL_SECONDS = 60 * 60 * 26;
const BURST_TTL_SECONDS = 120;

const DAILY_KEY = (accountId: string, day: string) => `zalo:rl:daily:${accountId}:${day}`;
const BURST_KEY = (accountId: string) => `zalo:rl:burst:${accountId}`;

type CheckResult = { allowed: boolean; reason?: string };

const RESERVE_SEND_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[2], 0, tonumber(ARGV[1]) - tonumber(ARGV[2]))

local daily = tonumber(redis.call('GET', KEYS[1]) or '0')
if daily >= tonumber(ARGV[3]) then
  return {0, ARGV[8]}
end

local burst = tonumber(redis.call('ZCOUNT', KEYS[2], tonumber(ARGV[1]) - tonumber(ARGV[2]), tonumber(ARGV[1])))
if burst >= tonumber(ARGV[4]) then
  return {0, ARGV[9]}
end

redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
redis.call('ZADD', KEYS[2], tonumber(ARGV[1]), ARGV[7])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[6]))
return {1, ''}
`;

class InMemoryLimiter {
  private dailyCounts = new Map<string, { count: number; date: string }>();
  private recentSends = new Map<string, number[]>();

  check(accountId: string): CheckResult {
    const today = todayKey();
    const daily = this.dailyCounts.get(accountId);
    if (daily && daily.date === today && daily.count >= DAILY_LIMIT) {
      return { allowed: false, reason: `Đã đạt giới hạn ${DAILY_LIMIT} tin/ngày` };
    }
    const now = Date.now();
    const recent = (this.recentSends.get(accountId) ?? []).filter((t) => now - t < BURST_WINDOW_MS);
    if (recent.length >= BURST_LIMIT) {
      return { allowed: false, reason: `Gửi quá nhanh (>${BURST_LIMIT} tin/30s)` };
    }
    return { allowed: true };
  }

  record(accountId: string): void {
    const now = Date.now();
    const today = todayKey();
    const recent = (this.recentSends.get(accountId) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    this.recentSends.set(accountId, recent);

    const daily = this.dailyCounts.get(accountId);
    if (daily && daily.date === today) {
      daily.count++;
    } else {
      this.dailyCounts.set(accountId, { count: 1, date: today });
    }
  }

  reserve(accountId: string): CheckResult {
    const check = this.check(accountId);
    if (!check.allowed) return check;
    this.record(accountId);
    return { allowed: true };
  }

  getDaily(accountId: string): number {
    const daily = this.dailyCounts.get(accountId);
    return daily && daily.date === todayKey() ? daily.count : 0;
  }
}

function todayKey(): string {
  return new Date().toISOString().split('T')[0];
}

const memory = new InMemoryLimiter();

async function withRedis<T>(fn: (client: NonNullable<Awaited<ReturnType<typeof getRedis>>>) => Promise<T>, fallback: () => T): Promise<T> {
  try {
    const client = await getRedis();
    if (!client) return fallback();
    return await fn(client);
  } catch (error) {
    logger.warn('[zalo:rate-limiter] Redis op failed, using in-memory:', error instanceof Error ? error.message : error);
    return fallback();
  }
}

class ZaloRateLimiter {
  /** Non-blocking check that returns whether sending is currently allowed. */
  async checkLimits(accountId: string): Promise<CheckResult> {
    return withRedis(
      async (client) => {
        const day = todayKey();
        const now = Date.now();
        const dailyKey = DAILY_KEY(accountId, day);
        const burstKey = BURST_KEY(accountId);

        const [dailyCountRaw, burstCount] = await Promise.all([
          client.get(dailyKey),
          client.zcount(burstKey, now - BURST_WINDOW_MS, now),
        ]);
        const dailyCount = Number(dailyCountRaw ?? 0);
        if (dailyCount >= DAILY_LIMIT) {
          return { allowed: false, reason: `Đã đạt giới hạn ${DAILY_LIMIT} tin/ngày` };
        }
        if ((burstCount ?? 0) >= BURST_LIMIT) {
          return { allowed: false, reason: `Gửi quá nhanh (>${BURST_LIMIT} tin/30s)` };
        }
        return { allowed: true };
      },
      () => memory.check(accountId),
    );
  }

  /**
   * Atomically reserve one outbound send token.
   *
   * Send paths must use this instead of checkLimits()+recordSend(); the latter
   * pair can overshoot under concurrent requests or multiple backend replicas.
   * A reserved token is intentionally not rolled back if the provider call
   * later fails, because staying under Zalo's quota is more important than
   * reclaiming a failed attempt.
   */
  async reserveSend(accountId: string): Promise<CheckResult> {
    const dailyLimitReason = `Đã đạt giới hạn ${DAILY_LIMIT} tin/ngày`;
    const burstLimitReason = `Gửi quá nhanh (>${BURST_LIMIT} tin/30s)`;

    return withRedis(
      async (client) => {
        const now = Date.now();
        const result = await (client as any).eval(
          RESERVE_SEND_LUA,
          2,
          DAILY_KEY(accountId, todayKey()),
          BURST_KEY(accountId),
          String(now),
          String(BURST_WINDOW_MS),
          String(DAILY_LIMIT),
          String(BURST_LIMIT),
          String(DAILY_TTL_SECONDS),
          String(BURST_TTL_SECONDS),
          `${now}-${Math.random().toString(36).slice(2, 8)}`,
          dailyLimitReason,
          burstLimitReason,
        );

        const [allowedRaw, reasonRaw] = Array.isArray(result) ? result : [0, 'Rate limit exceeded'];
        const allowed = Number(allowedRaw) === 1;
        return allowed ? { allowed: true } : { allowed: false, reason: String(reasonRaw || 'Rate limit exceeded') };
      },
      () => memory.reserve(accountId),
    );
  }

  /** Record a successful send so subsequent checks reflect it. Prefer reserveSend() for send paths. */
  async recordSend(accountId: string): Promise<void> {
    await withRedis(
      async (client) => {
        const day = todayKey();
        const now = Date.now();
        const dailyKey = DAILY_KEY(accountId, day);
        const burstKey = BURST_KEY(accountId);

        const pipeline = client.multi();
        pipeline.incr(dailyKey);
        pipeline.expire(dailyKey, DAILY_TTL_SECONDS);
        pipeline.zadd(burstKey, now, `${now}-${Math.random().toString(36).slice(2, 8)}`);
        pipeline.zremrangebyscore(burstKey, 0, now - BURST_WINDOW_MS);
        pipeline.expire(burstKey, BURST_TTL_SECONDS);
        await pipeline.exec();
      },
      () => memory.record(accountId),
    );
  }

  async getDailyCount(accountId: string): Promise<number> {
    return withRedis(
      async (client) => {
        const raw = await client.get(DAILY_KEY(accountId, todayKey()));
        return Number(raw ?? 0);
      },
      () => memory.getDaily(accountId),
    );
  }
}

export const zaloRateLimiter = new ZaloRateLimiter();
