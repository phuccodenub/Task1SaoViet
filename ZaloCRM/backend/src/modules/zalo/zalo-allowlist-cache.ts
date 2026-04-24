/**
 * zalo-allowlist-cache.ts — In-memory cache for ingest policy + per-account allowlist.
 *
 * Hot path: every incoming Zalo message calls these helpers, so we keep a 60s TTL
 * snapshot of (policy, allowed thread set) per account to avoid hammering the DB.
 * The cache is invalidated explicitly by allowlist CRUD endpoints when state
 * changes; the TTL is just a safety net in case an invalidation is missed.
 */
import { prisma } from '../../shared/database/prisma-client.js';

export type IngestPolicy = 'all' | 'allowlist';

interface CacheEntry {
  policy: IngestPolicy;
  allowedThreads: Set<string>; // externalThreadId of enabled allowlist rows
  cachedAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

async function loadEntry(accountId: string): Promise<CacheEntry> {
  const account = await prisma.zaloAccount.findUnique({
    where: { id: accountId },
    select: { ingestPolicy: true },
  });
  const policy: IngestPolicy =
    account?.ingestPolicy === 'allowlist' ? 'allowlist' : 'all';

  // Only load allowlist rows when we actually need them
  let allowedThreads = new Set<string>();
  if (policy === 'allowlist') {
    const rows = await prisma.zaloThreadAllowlist.findMany({
      where: { zaloAccountId: accountId, enabled: true },
      select: { externalThreadId: true },
    });
    allowedThreads = new Set(rows.map((r) => r.externalThreadId));
  }

  const entry: CacheEntry = { policy, allowedThreads, cachedAt: Date.now() };
  cache.set(accountId, entry);
  return entry;
}

async function getEntry(accountId: string): Promise<CacheEntry> {
  const cached = cache.get(accountId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached;
  return loadEntry(accountId);
}

/** Returns the current ingest policy for an account ('all' fallback if missing). */
export async function getIngestPolicy(accountId: string): Promise<IngestPolicy> {
  return (await getEntry(accountId)).policy;
}

/**
 * True when the policy is 'all', or when 'allowlist' and the thread is enabled.
 * Used by message-handler to decide visibility for newly-created conversations.
 */
export async function isThreadAllowed(
  accountId: string,
  externalThreadId: string,
): Promise<boolean> {
  const entry = await getEntry(accountId);
  if (entry.policy === 'all') return true;
  return entry.allowedThreads.has(externalThreadId);
}

/** Drop the cached snapshot so the next read reflects fresh DB state. */
export function invalidateAllowlistCache(accountId: string): void {
  cache.delete(accountId);
}

/** Test helper — exported for unit tests, not for runtime use. */
export function _resetCacheForTests(): void {
  cache.clear();
}
