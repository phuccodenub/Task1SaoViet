/**
 * redis-client.ts — optional ioredis singleton shared across modules.
 *
 * Returns `null` when no Redis endpoint is configured, so callers can fall
 * back to in-memory behaviour. Set either `REDIS_URL` (e.g.
 * `redis://:password@redis:6379/0`) OR `REDIS_HOST`/`REDIS_PORT`/
 * `REDIS_PASSWORD` in the environment to enable it.
 */
import { logger } from '../utils/logger.js';

type IORedis = import('ioredis').default;

let client: IORedis | null = null;
let initTried = false;

export async function getRedis(): Promise<IORedis | null> {
  if (client) return client;
  if (initTried) return null;
  initTried = true;

  const url = process.env.REDIS_URL;
  const host = process.env.REDIS_HOST;
  if (!url && !host) {
    logger.info('[redis] No REDIS_URL/REDIS_HOST — running without Redis');
    return null;
  }

  try {
    // ioredis ships as CommonJS — under NodeNext ESM the namespace import is
    // typed as the module object, so we resolve the actual constructor at
    // runtime via the module's `default` field (or fall back to the namespace
    // itself when no default is exposed).
    const mod = (await import('ioredis')) as unknown as {
      default?: new (...args: any[]) => IORedis;
    } & (new (...args: any[]) => IORedis);
    const IORedisCtor = (mod.default ?? (mod as unknown as new (...args: any[]) => IORedis));
    const instance: IORedis = url
      ? new IORedisCtor(url, { lazyConnect: false, maxRetriesPerRequest: 2 })
      : new IORedisCtor({
          host,
          port: Number(process.env.REDIS_PORT ?? 6379),
          password: process.env.REDIS_PASSWORD || undefined,
          db: Number(process.env.REDIS_DB ?? 0),
          lazyConnect: false,
          maxRetriesPerRequest: 2,
        });

    instance.on('error', (err) => logger.warn('[redis] connection error:', err.message));
    instance.on('ready', () => logger.info('[redis] ready'));
    client = instance;
    return client;
  } catch (error) {
    logger.warn('[redis] Failed to initialise ioredis, falling back to in-memory:', error instanceof Error ? error.message : error);
    return null;
  }
}
