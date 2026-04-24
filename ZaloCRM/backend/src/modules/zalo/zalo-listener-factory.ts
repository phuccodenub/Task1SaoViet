/**
 * zalo-listener-factory.ts — sets up zca-js listener events for one Zalo account.
 * Handles message routing, user-info caching, group detection, and undo events.
 * Extracted from ZaloAccountPool to keep zalo-pool.ts under 200 lines.
 */
import type { Server } from 'socket.io';
import { logger } from '../../shared/utils/logger.js';
import { handleIncomingMessage, handleMessageUndo } from '../chat/message-handler.js';
import { detectContentType, updateContactAvatar } from './zalo-message-helpers.js';

// Note: after Fix #23 all account-specific socket events emit to
// `account:<id>` rooms, so the previous `resolveAccountOrgId` helper and
// its per-account cache are no longer needed.

/**
 * Emit chat:message with payload that respects visibility AND per-account ACL
 * (Fix #9 + Fix #13 + Fix #19):
 *   - visible → full payload sent to `account:<id>` room. Members joined this
 *               room only after passing ZaloAccountAccess in zalo-socket.ts,
 *               so message content stays within the account's ACL — same
 *               boundary the REST list endpoint enforces via requireZaloAccess.
 *   - pending → envelope sent to `account:<id>` room too (NOT org room),
 *               because an org-wide pending broadcast would let members
 *               without per-account access discover that account X received a
 *               message at time T — metadata leak even without content.
 *               Payload is stripped to `{accountId, visibility}` only: the
 *               counter in the UI is per-account, so the client refetches
 *               `/conversations/counts?accountId=X` on this event. No
 *               conversationId/messageId/sentAt crosses the boundary.
 *   - hidden  → no emit at all.
 */
function emitChatMessage(
  io: Server | null,
  accountId: string,
  result: {
    orgId: string;
    message: { id: string; sentAt: Date };
    conversationId: string;
    visibility: 'visible' | 'pending' | 'hidden';
  },
): void {
  if (!io) return;
  if (result.visibility === 'hidden') return; // fully muted

  const room = `account:${accountId}`;

  if (result.visibility === 'pending') {
    // Minimal badge-invalidation signal — no conv/message identifiers leak
    // outside the account ACL boundary. UI refetches counts on receipt.
    io.to(room).emit('chat:message', {
      accountId,
      visibility: 'pending',
    });
    return;
  }

  // Full payload only for visible messages
  io.to(room).emit('chat:message', {
    accountId,
    message: result.message,
    conversationId: result.conversationId,
    visibility: 'visible',
  });
}

// Cached user info entry with 5-minute TTL
export interface UserInfoCacheEntry {
  zaloName: string;
  avatar: string;
  phone?: string;
  cachedAt: number;
}

const USER_INFO_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Fetch zaloName + avatar from API with a per-pool in-memory cache
async function resolveZaloName(
  api: any,
  uid: string,
  cache: Map<string, UserInfoCacheEntry>,
): Promise<{ zaloName: string; avatar: string }> {
  const cached = cache.get(uid);
  if (cached && Date.now() - cached.cachedAt < USER_INFO_CACHE_TTL_MS) {
    return { zaloName: cached.zaloName, avatar: cached.avatar };
  }

  try {
    const result = await api.getUserInfo(uid);
    const profiles = result?.changed_profiles || {};
    const profile = profiles[uid] || profiles[`${uid}_0`];
    if (profile) {
      const entry: UserInfoCacheEntry = {
        zaloName:
          profile.zaloName ||
          profile.zalo_name ||
          profile.displayName ||
          profile.display_name ||
          '',
        avatar: profile.avatar || '',
        phone: profile.phoneNumber || '',
        cachedAt: Date.now(),
      };
      cache.set(uid, entry);
      return { zaloName: entry.zaloName, avatar: entry.avatar };
    }
  } catch (err) {
    logger.warn(`[zalo] getUserInfo failed for ${uid}:`, err);
  }
  return { zaloName: '', avatar: '' };
}

// Fetch group display name from the zca-js API
async function resolveGroupName(api: any, groupId: string): Promise<string> {
  try {
    const result = await api.getGroupInfo(groupId);
    const info = result?.gridInfoMap?.[groupId];
    return info?.name || '';
  } catch (err) {
    logger.warn(`[zalo] getGroupInfo failed for ${groupId}:`, err);
    return '';
  }
}

export interface ListenerContext {
  accountId: string;
  api: any;
  io: Server | null;
  userInfoCache: Map<string, UserInfoCacheEntry>;
  onDisconnected: (accountId: string) => void;
}

/**
 * Attach all zca-js listener events for the given account.
 * Calls listener.start() with retryOnClose at the end.
 */
export function attachZaloListener(ctx: ListenerContext): void {
  const { accountId, api, io, userInfoCache, onDisconnected } = ctx;
  const listener = api.listener;

  listener.on('connected', () => {
    logger.info(`[zalo:${accountId}] Listener connected`);
  });

  listener.on('message', async (message: any) => {
    try {
      // ThreadType in zca-js: 0 = User, 1 = Group
      const isGroup = message.type === 1;
      const senderUid = String(message.data?.uidFrom || '');

      // Resolve display name — prefer zaloName from API over dName
      let senderName: string = message.data?.dName || '';
      if (senderUid && api.getUserInfo) {
        // For self messages, resolve recipient name using threadId
        // For contact messages, resolve sender name using senderUid
        const resolveUid = message.isSelf ? (message.threadId || '') : senderUid;
        if (resolveUid) {
          const userInfo = await resolveZaloName(api, resolveUid, userInfoCache);
          if (!message.isSelf) {
            if (userInfo.zaloName) senderName = userInfo.zaloName;
            if (userInfo.avatar) updateContactAvatar(senderUid, userInfo.avatar);
          }
        }
      }

      // Resolve group name for group threads
      let groupName: string | undefined;
      if (isGroup && message.threadId) {
        groupName = await resolveGroupName(api, message.threadId);
      }

      const rawContent = message.data?.content;
      const content =
        typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent || '');
      const contentType = detectContentType(message.data?.msgType, rawContent);

      const result = await handleIncomingMessage({
        accountId,
        senderUid,
        senderName,
        content,
        contentType,
        msgId: String(message.data?.msgId || ''),
        timestamp: parseInt(message.data?.ts || String(Date.now())),
        isSelf: message.isSelf || false,
        threadId: message.threadId || '',
        threadType: isGroup ? 'group' : 'user',
        groupName,
        attachments: [],
      });

      if (result) {
        emitChatMessage(io, accountId, result);
      }
    } catch (err) {
      logger.error(`[zalo:${accountId}] Message handler error:`, err);
    }
  });

  listener.on('undo', async (data: any) => {
    const msgId = data.data?.msgId || data.msgId;
    if (msgId) {
      await handleMessageUndo(accountId, String(msgId));
      // Fix #23: account-specific → account room only
      io?.to(`account:${accountId}`).emit('chat:deleted', { accountId, msgId: String(msgId) });
    }
  });

  // Backfill messages delivered on reconnect (missed while disconnected)
  listener.on('old_messages', async (messages: any[], type: number) => {
    const threadType = type === 1 ? 'group' : 'user';
    logger.info(`[zalo:${accountId}] Received ${messages.length} old ${threadType} messages`);

    for (const message of messages) {
      try {
        const senderUid = String(message.data?.uidFrom || '');
        let senderName = message.data?.dName || '';

        // Resolve display name for non-self messages
        if (!message.isSelf && senderUid && api.getUserInfo) {
          const userInfo = await resolveZaloName(api, senderUid, userInfoCache);
          if (userInfo.zaloName) senderName = userInfo.zaloName;
        }

        let groupName: string | undefined;
        if (threadType === 'group' && message.threadId) {
          groupName = await resolveGroupName(api, message.threadId);
        }

        const rawContent = message.data?.content;
        const content =
          typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent || '');
        const contentType = detectContentType(message.data?.msgType, rawContent);

        const result = await handleIncomingMessage({
          accountId,
          senderUid,
          senderName,
          content,
          contentType,
          msgId: String(message.data?.msgId || ''),
          timestamp: parseInt(message.data?.ts || String(Date.now())),
          isSelf: message.isSelf || false,
          threadId: message.threadId || '',
          threadType,
          groupName,
          attachments: [],
          isBackfill: true,
        });

        if (result) {
          emitChatMessage(io, accountId, result);
        }
      } catch (err) {
        logger.warn(`[zalo:${accountId}] old_messages processing error:`, err);
      }
    }
  });

  // Group system events: member join/leave/kick, name change, etc.
  listener.on('group_event', (event: any) => {
    logger.info(`[zalo:${accountId}] Group event: type=${event?.type ?? 'unknown'}`, {
      groupId: event?.groupId,
      actorId: event?.actorId,
      members: event?.members,
    });
    // Future: store as system message in the group conversation
  });

  // Friend lifecycle events: request sent/accepted/blocked
  listener.on('friend_event', (event: any) => {
    logger.info(`[zalo:${accountId}] Friend event: type=${event?.type ?? 'unknown'}`, {
      fromId: event?.fromId,
      toId: event?.toId,
    });
    // Future: update contact status based on friend_event type
  });

  listener.on('closed', (code: number, reason: string) => {
    logger.warn(`[zalo:${accountId}] Listener closed: ${code} ${reason}`);
    onDisconnected(accountId);
    // Fix #23: account-specific → account room only
    io?.to(`account:${accountId}`).emit('zalo:disconnected', { accountId, code, reason });
  });

  listener.on('error', (err: any) => {
    logger.error(`[zalo:${accountId}] Listener error:`, err);
  });

  listener.start({ retryOnClose: true });
}
