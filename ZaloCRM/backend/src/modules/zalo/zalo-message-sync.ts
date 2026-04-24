/**
 * zalo-message-sync.ts — polling backup for group message history.
 * Runs periodically per connected account, calls getGroupChatHistory()
 * for active groups, and inserts any messages missing from the database.
 *
 * This is a safety net — the primary sync path is selfListen + old_messages.
 * The batch routine is also reused by the on-demand /fetch-history endpoint
 * (see zalo-history-routes.ts) so a single dedup/persist code path handles
 * both the cron and user-initiated backfills.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { handleIncomingMessage } from '../chat/message-handler.js';
import { detectContentType } from './zalo-message-helpers.js';

const SYNC_INTERVAL_MS = 5 * 60_000; // 5 minutes
const MAX_GROUPS_PER_SYNC = 20;
const MESSAGES_PER_GROUP = 50;

// Track active sync intervals per account
const syncIntervals = new Map<string, ReturnType<typeof setInterval>>();

export interface GroupBatchResult {
  added: number;
  oldestTs: number | null; // epoch ms of earliest message in this batch
  more: boolean; // Zalo indicates more history is available upstream
}

/**
 * Fetch one batch of group history and persist any messages not yet in DB.
 * Reused by both the periodic cron (syncGroupMessages) and the on-demand
 * /fetch-history endpoint. Uses handleIncomingMessage with isBackfill=true
 * so automation and webhooks are skipped.
 */
export async function fetchAndPersistGroupBatch(
  api: any,
  conv: { id: string; externalThreadId: string },
  accountId: string,
  count: number,
): Promise<GroupBatchResult> {
  const history = await api.getGroupChatHistory(conv.externalThreadId, count);
  const messages: any[] = history?.groupMsgs || history?.data?.groupMsgs || [];
  const more = Boolean(history?.more ?? history?.data?.more ?? 0);

  if (messages.length === 0) {
    return { added: 0, oldestTs: null, more: false };
  }

  // Collect msgIds for a single batch dedup query
  const msgIdMap = new Map<string, any>();
  for (const msg of messages) {
    const zaloMsgId = String(msg.data?.msgId || msg.data?.cliMsgId || '');
    if (zaloMsgId) msgIdMap.set(zaloMsgId, msg);
  }
  if (msgIdMap.size === 0) return { added: 0, oldestTs: null, more };

  const existing = await prisma.message.findMany({
    where: { conversationId: conv.id, zaloMsgId: { in: [...msgIdMap.keys()] } },
    select: { zaloMsgId: true },
  });
  const existingIds = new Set(existing.map((m: any) => m.zaloMsgId));

  let added = 0;
  let oldestTs: number | null = null;

  for (const [zaloMsgId, msg] of msgIdMap) {
    if (existingIds.has(zaloMsgId)) continue;

    const rawContent = msg.data?.content;
    const content =
      typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent || '');
    const ts = parseInt(msg.data?.ts || String(Date.now()));
    if (oldestTs === null || ts < oldestTs) oldestTs = ts;

    const result = await handleIncomingMessage({
      accountId,
      senderUid: String(msg.data?.uidFrom || ''),
      senderName: msg.data?.dName || '',
      content,
      contentType: detectContentType(msg.data?.msgType, rawContent),
      msgId: zaloMsgId,
      timestamp: ts,
      isSelf: msg.isSelf || false,
      threadId: conv.externalThreadId,
      threadType: 'group',
      attachments: [],
      isBackfill: true,
    });

    if (result) added++;
  }

  return { added, oldestTs, more };
}

/**
 * Sync recent group messages for one account.
 * Returns the number of newly inserted messages.
 */
async function syncGroupMessages(api: any, accountId: string): Promise<number> {
  const account = await prisma.zaloAccount.findUnique({
    where: { id: accountId },
    select: { orgId: true },
  });
  if (!account) return 0;

  // Get most recently active group conversations
  const groupConvs = await prisma.conversation.findMany({
    where: { zaloAccountId: accountId, threadType: 'group' },
    select: { id: true, externalThreadId: true },
    take: MAX_GROUPS_PER_SYNC,
    orderBy: { lastMessageAt: 'desc' },
  });

  let synced = 0;

  for (const conv of groupConvs) {
    if (!conv.externalThreadId) continue;
    try {
      const result = await fetchAndPersistGroupBatch(
        api,
        { id: conv.id, externalThreadId: conv.externalThreadId },
        accountId,
        MESSAGES_PER_GROUP,
      );
      synced += result.added;
    } catch (err) {
      logger.warn(`[sync:${accountId}] Group ${conv.externalThreadId} failed:`, err);
    }
  }

  return synced;
}

/** Start periodic group sync for an account. */
export function startMessageSync(api: any, accountId: string): void {
  // Don't start duplicate sync
  if (syncIntervals.has(accountId)) return;

  const interval = setInterval(async () => {
    try {
      const count = await syncGroupMessages(api, accountId);
      if (count > 0) {
        logger.info(`[sync:${accountId}] Backfilled ${count} group messages`);
      }
    } catch (err) {
      logger.warn(`[sync:${accountId}] Sync error:`, err);
    }
  }, SYNC_INTERVAL_MS);

  syncIntervals.set(accountId, interval);
  logger.info(`[sync:${accountId}] Started group message sync (every ${SYNC_INTERVAL_MS / 1000}s)`);
}

/** Stop periodic sync for an account. */
export function stopMessageSync(accountId: string): void {
  const interval = syncIntervals.get(accountId);
  if (interval) {
    clearInterval(interval);
    syncIntervals.delete(accountId);
    logger.info(`[sync:${accountId}] Stopped group message sync`);
  }
}
