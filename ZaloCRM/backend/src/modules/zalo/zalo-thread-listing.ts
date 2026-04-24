/**
 * zalo-thread-listing.ts — Fetch friends + groups from the live Zalo SDK and
 * annotate each with CRM state (allowlisted? already has a conversation?).
 *
 * Results are cached in-memory for 5 minutes per account to avoid hammering
 * the Zalo API when the allowlist UI polls or users page back and forth.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { zaloPool } from './zalo-pool.js';

const CACHE_TTL_MS = 5 * 60_000;

export interface AvailableThread {
  externalThreadId: string;
  threadType: 'user' | 'group';
  displayName: string;
  avatar: string;
  phone?: string;
  inAllowlist: boolean;
  allowlistEnabled: boolean;
  hasConversation: boolean;
  conversationId: string | null;
  conversationVisibility: string | null;
  lastMessageAt: Date | null;
}

interface CacheEntry {
  threads: AvailableThread[];
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Force-refresh — used by mutations that change downstream data. */
export function invalidateThreadListingCache(accountId: string): void {
  cache.delete(accountId);
}

export async function listAvailableThreads(
  accountId: string,
  orgId: string,
): Promise<{ threads: AvailableThread[]; cachedAt: number }> {
  const cached = cache.get(accountId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return { threads: cached.threads, cachedAt: cached.cachedAt };
  }

  const instance = zaloPool.getInstance(accountId);
  if (!instance?.api) {
    throw new Error('Zalo account not connected');
  }

  // Fetch friends + groups in parallel — both are already-paginated bulk calls
  const [friendsRaw, groupsRaw] = await Promise.all([
    instance.api.getAllFriends().catch(() => ({})),
    instance.api.getAllGroups().catch(() => ({})),
  ]);

  // Normalize Zalo SDK responses (shape varies slightly between calls)
  const friends: AvailableThread[] = Object.values(friendsRaw || {}).map((f: any) => ({
    externalThreadId: String(f.userId || f.uid || ''),
    threadType: 'user' as const,
    displayName: f.zaloName || f.displayName || f.display_name || '',
    avatar: f.avatar || '',
    phone: f.phoneNumber || '',
    inAllowlist: false,
    allowlistEnabled: false,
    hasConversation: false,
    conversationId: null,
    conversationVisibility: null,
    lastMessageAt: null,
  })).filter((f) => f.externalThreadId);

  // getAllGroups typically returns { gridInfoMap: { [groupId]: { name, avt, ... } } }
  // or a flat object keyed by groupId. Handle both shapes defensively.
  const groupMap = (groupsRaw as any)?.gridInfoMap || groupsRaw || {};
  const groups: AvailableThread[] = Object.entries(groupMap).map(([gid, info]: [string, any]) => ({
    externalThreadId: String(gid),
    threadType: 'group' as const,
    displayName: info?.name || info?.groupName || '',
    avatar: info?.avt || info?.avatar || '',
    inAllowlist: false,
    allowlistEnabled: false,
    hasConversation: false,
    conversationId: null,
    conversationVisibility: null,
    lastMessageAt: null,
  })).filter((g) => g.externalThreadId);

  const threads = [...friends, ...groups];
  if (threads.length === 0) {
    cache.set(accountId, { threads, cachedAt: Date.now() });
    return { threads, cachedAt: Date.now() };
  }

  // Annotate with CRM state via two scoped lookups
  const threadIds = threads.map((t) => t.externalThreadId);

  const [allowlistRows, convRows] = await Promise.all([
    prisma.zaloThreadAllowlist.findMany({
      where: { zaloAccountId: accountId, externalThreadId: { in: threadIds } },
      select: { externalThreadId: true, enabled: true },
    }),
    prisma.conversation.findMany({
      where: { orgId, zaloAccountId: accountId, externalThreadId: { in: threadIds } },
      select: { id: true, externalThreadId: true, visibility: true, lastMessageAt: true },
    }),
  ]);

  const allowMap = new Map(allowlistRows.map((r) => [r.externalThreadId, r.enabled]));
  const convMap = new Map(convRows.map((r) => [r.externalThreadId, r]));

  for (const t of threads) {
    const enabled = allowMap.get(t.externalThreadId);
    t.inAllowlist = enabled !== undefined;
    t.allowlistEnabled = enabled === true;
    const conv = convMap.get(t.externalThreadId);
    if (conv) {
      t.hasConversation = true;
      t.conversationId = conv.id;
      t.conversationVisibility = conv.visibility;
      t.lastMessageAt = conv.lastMessageAt;
    }
  }

  const entry = { threads, cachedAt: Date.now() };
  cache.set(accountId, entry);
  return entry;
}
