/**
 * message-handler.ts — persists incoming Zalo messages to the database.
 * Called from zalo-pool's startListener on every 'message' / 'undo' event.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { randomUUID } from 'node:crypto';
import { emitWebhook } from '../api/webhook-service.js';
import { runAutomationRules } from '../automation/automation-service.js';
import { getIngestPolicy, isThreadAllowed } from '../zalo/zalo-allowlist-cache.js';

export interface IncomingMessage {
  accountId: string;
  senderUid: string;
  senderName: string;       // zaloName (from cache or dName fallback)
  content: string;
  contentType: string;      // text, image, sticker, video, voice, gif, link, file
  msgId: string;
  timestamp: number;        // epoch ms
  isSelf: boolean;
  threadId: string;         // For user: contact UID. For group: group ID
  threadType: 'user' | 'group'; // user or group conversation
  groupName?: string;       // group name if group message
  attachments?: any[];
  isBackfill?: boolean;     // true for old_messages / sync backfill — skip automations
}

export interface HandleMessageResult {
  message: {
    id: string;
    conversationId: string;
    zaloMsgId: string | null;
    senderType: string;
    senderUid: string | null;
    senderName: string | null;
    content: string | null;
    contentType: string;
    attachments: any;
    isDeleted: boolean;
    deletedAt: Date | null;
    sentAt: Date;
    repliedByUserId: string | null;
    createdAt: Date;
  };
  conversationId: string;
  orgId: string;
  contactId: string | null;
  /** Snapshot of conversation visibility at the time the message was persisted. */
  visibility: 'visible' | 'pending' | 'hidden';
}

export async function handleIncomingMessage(
  msg: IncomingMessage,
): Promise<HandleMessageResult | null> {
  try {
    const account = await prisma.zaloAccount.findUnique({
      where: { id: msg.accountId },
      select: { orgId: true, ownerUserId: true },
    });
    if (!account) return null;

    // Resolve visibility BEFORE creating any contact/conversation rows so we
    // can gate every side-effect (contact.created webhook, message.received
    // webhook, automation rules) on a single source of truth. Without this
    // pre-check, upsertContact would emit contact.created for unapproved
    // pending threads — leaking private contacts to external systems.
    const plannedVisibility = await resolvePlannedVisibility(msg);

    const contactId = await upsertContact(msg, account.orgId, plannedVisibility);

    // Update lastActivity for lead scoring freshness
    if (contactId) {
      prisma.contact.update({
        where: { id: contactId },
        data: { lastActivity: new Date() },
      }).catch(() => {});
    }

    const conversation = await findOrCreateConversation(
      msg,
      account.orgId,
      contactId,
      plannedVisibility,
    );

    const sentAt = new Date(msg.timestamp);

    // Dedup guard for self messages: if a self message with same content exists
    // in the last 30 seconds, this is likely a selfListen echo of a CRM-sent message
    if (msg.isSelf && msg.msgId) {
      const recentDupe = await prisma.message.findFirst({
        where: {
          conversationId: conversation.id,
          senderType: 'self',
          content: msg.content || '',
          sentAt: { gte: new Date(Date.now() - 30_000) },
        },
        select: { id: true, zaloMsgId: true },
      });
      if (recentDupe) {
        // If the existing record has no zaloMsgId, backfill it for future dedup
        if (!recentDupe.zaloMsgId && msg.msgId) {
          await prisma.message.update({
            where: { id: recentDupe.id },
            data: { zaloMsgId: msg.msgId },
          }).catch(() => {});
        }
        logger.debug(`[message-handler] Skipping self echo: content match within 30s`);
        return null;
      }
    }

    let message;
    try {
      message = await prisma.message.create({
        data: {
          id: randomUUID(),
          conversationId: conversation.id,
          zaloMsgId: msg.msgId || null,
          senderType: msg.isSelf ? 'self' : 'contact',
          senderUid: msg.senderUid,
          senderName: msg.senderName || null,
          content: msg.content || '',
          contentType: msg.contentType || 'text',
          attachments: msg.attachments ?? [],
          sentAt,
        },
      });
    } catch (err: any) {
      // P2002 = unique constraint violation → duplicate zaloMsgId, skip silently
      if (err?.code === 'P2002') {
        logger.debug(`[message-handler] Skipping duplicate zaloMsgId=${msg.msgId}`);
        return null;
      }
      throw err;
    }

    await updateConversationAfterMessage(conversation.id, sentAt, msg.isSelf);

    // Track first outbound contact date — set once when agent sends first message
    if (msg.isSelf && contactId) {
      prisma.contact.updateMany({
        where: { id: contactId, firstContactDate: null },
        data: { firstContactDate: new Date(msg.timestamp) },
      }).catch(() => {});
    }

    // Resolve current visibility — pending conversations skip automation/webhook
    // so noise threads don't trigger CRM workflows before the user reviews them.
    const visibility = (conversation.visibility ?? 'visible') as
      | 'visible'
      | 'pending'
      | 'hidden';

    // Skip webhooks and automation for backfilled messages (old_messages / sync)
    // and for any non-visible conversation (pending/hidden).
    if (msg.isBackfill || visibility !== 'visible') {
      return {
        message,
        conversationId: conversation.id,
        orgId: account.orgId,
        contactId,
        visibility,
      };
    }

    // Emit webhook for message event (fire-and-forget).
    // Payload carries every identifier an external consumer needs to reply via
    // the public API (zaloAccountId + threadId + threadType) without having to
    // re-query the DB. senderType + contactId let omnichannel bots route
    // immediately without ambiguity (e.g. filter out self echoes).
    emitWebhook(account.orgId, msg.isSelf ? 'message.sent' : 'message.received', {
      messageId: message.id,
      conversationId: conversation.id,
      zaloAccountId: msg.accountId,
      threadId: msg.threadId,
      threadType: msg.threadType,
      senderType: msg.isSelf ? 'self' : 'contact',
      senderUid: msg.senderUid,
      senderName: msg.senderName || null,
      contactId,
      content: msg.content,
      contentType: msg.contentType,
      sentAt: message.sentAt,
    });

    if (!msg.isSelf) {
      const org = await prisma.organization.findUnique({
        where: { id: account.orgId },
        select: { id: true, name: true },
      });
      const contact = contactId
        ? await prisma.contact.findUnique({
            where: { id: contactId },
            select: { id: true, fullName: true, crmName: true, phone: true, status: true, source: true, assignedUserId: true },
          })
        : null;
      const conversationDetails = await prisma.conversation.findUnique({
        where: { id: conversation.id },
        select: { id: true, unreadCount: true, externalThreadId: true, threadType: true, zaloAccountId: true },
      });

      void runAutomationRules({
        trigger: 'message_received',
        orgId: account.orgId,
        org,
        contact,
        conversation: conversationDetails
          ? {
              id: conversationDetails.id,
              unreadCount: conversationDetails.unreadCount,
              threadId: conversationDetails.externalThreadId,
              threadType: conversationDetails.threadType,
              zaloAccountId: conversationDetails.zaloAccountId,
            }
          : null,
        message: { id: message.id, content: message.content, contentType: message.contentType, senderType: message.senderType },
      });
    }

    return {
      message,
      conversationId: conversation.id,
      orgId: account.orgId,
      contactId,
      visibility,
    };
  } catch (err) {
    logger.error('[message-handler] handleIncomingMessage error:', err);
    return null;
  }
}

// Upsert contact — handles both user and group conversations.
// `plannedVisibility` controls the contact.created webhook: pending/hidden
// threads must NOT leak via webhooks until a user approves them.
async function upsertContact(
  msg: IncomingMessage,
  orgId: string,
  plannedVisibility: 'visible' | 'pending',
): Promise<string | null> {
  const allowSideEffects = plannedVisibility === 'visible';
  // Group messages: create/update a "contact" record representing the group
  if (msg.threadType === 'group') {
    const groupUid = msg.threadId;
    let groupContact = await prisma.contact.findFirst({
      where: { zaloUid: groupUid, orgId },
      select: { id: true, fullName: true },
    });

    if (!groupContact) {
      groupContact = await prisma.contact.create({
        data: {
          id: randomUUID(),
          orgId,
          zaloUid: groupUid,
          fullName: msg.groupName || 'Nhóm',
          metadata: { isGroup: true },
        },
        select: { id: true, fullName: true },
      });
      // Emit webhook for new contact created — only when conversation is visible
      if (allowSideEffects) {
        emitWebhook(orgId, 'contact.created', { contactId: groupContact.id, fullName: groupContact.fullName });
      }
    } else if (msg.groupName && groupContact.fullName !== msg.groupName) {
      await prisma.contact.update({
        where: { id: groupContact.id },
        data: { fullName: msg.groupName },
      });
    }
    return groupContact.id;
  }

  // For self messages on user threads, the contact is the thread recipient (threadId = contact UID)
  const contactUid = msg.isSelf ? msg.threadId : msg.senderUid;
  const contactName = msg.isSelf ? '' : msg.senderName; // self msgs don't carry recipient name

  let contact = await prisma.contact.findFirst({
    where: { zaloUid: contactUid, orgId },
    select: { id: true, fullName: true },
  });

  if (!contact) {
    contact = await prisma.contact.create({
      data: {
        id: randomUUID(),
        orgId,
        zaloUid: contactUid,
        fullName: contactName || 'Unknown',
      },
      select: { id: true, fullName: true },
    });
    // Emit webhook for new contact created — only when conversation is visible
    if (allowSideEffects) {
      emitWebhook(orgId, 'contact.created', { contactId: contact.id, fullName: contact.fullName });
    }
  } else if (contactName && contact.fullName !== contactName && contact.fullName === 'Unknown') {
    // Update name only if currently "Unknown" — don't overwrite user-edited names
    await prisma.contact.update({
      where: { id: contact.id },
      data: { fullName: contactName },
    });
  }

  return contact.id;
}

/**
 * Compute what the conversation's visibility WILL BE after this message is
 * processed, considering both existing conversation state and the account's
 * ingest policy. Used to gate side-effects before any DB writes happen.
 *   - existing conv → its current visibility wins (allowlist mutations may
 *     have flipped it; we never auto-revert here)
 *   - new conv      → policy='all' or thread allow-listed → 'visible'
 *                     policy='allowlist' and thread missing → 'pending'
 */
async function resolvePlannedVisibility(
  msg: IncomingMessage,
): Promise<'visible' | 'pending'> {
  const existing = await prisma.conversation.findFirst({
    where: { zaloAccountId: msg.accountId, externalThreadId: msg.threadId },
    select: { visibility: true },
  });
  if (existing) {
    // 'hidden' downgrades to 'pending' for gating purposes (still skip side-effects)
    return existing.visibility === 'visible' ? 'visible' : 'pending';
  }
  try {
    const policy = await getIngestPolicy(msg.accountId);
    if (policy === 'allowlist') {
      const allowed = await isThreadAllowed(msg.accountId, msg.threadId);
      return allowed ? 'visible' : 'pending';
    }
  } catch (err) {
    // Fail-open: if policy resolution errors, treat as visible (preserve v2.1 behavior)
    logger.warn('[message-handler] ingest policy resolution failed:', err);
  }
  return 'visible';
}

// Find or create conversation — externalThreadId = threadId for both user and group.
// `plannedVisibility` is the result of resolvePlannedVisibility() so we don't
// recompute (and risk drift from the value used to gate side-effects).
async function findOrCreateConversation(
  msg: IncomingMessage,
  orgId: string,
  contactId: string | null,
  plannedVisibility: 'visible' | 'pending',
) {
  const externalThreadId = msg.threadId;

  const existing = await prisma.conversation.findFirst({
    where: { zaloAccountId: msg.accountId, externalThreadId },
    select: { id: true, visibility: true },
  });

  if (existing) return existing;

  return prisma.conversation.create({
    data: {
      id: randomUUID(),
      orgId,
      zaloAccountId: msg.accountId,
      contactId: msg.threadType === 'user' ? contactId : contactId,
      threadType: msg.threadType,
      externalThreadId,
      lastMessageAt: new Date(msg.timestamp),
      unreadCount: msg.isSelf ? 0 : 1,
      isReplied: msg.isSelf,
      visibility: plannedVisibility,
    },
    select: { id: true, visibility: true },
  });
}

// Update conversation metadata after a new message
async function updateConversationAfterMessage(
  conversationId: string,
  sentAt: Date,
  isSelf: boolean,
): Promise<void> {
  const updateData: any = { lastMessageAt: sentAt };
  if (isSelf) {
    updateData.isReplied = true;
    updateData.unreadCount = 0;
  } else {
    updateData.unreadCount = { increment: 1 };
    updateData.isReplied = false;
  }
  await prisma.conversation.update({ where: { id: conversationId }, data: updateData });
}

// Soft-delete a message by its Zalo message ID
export async function handleMessageUndo(accountId: string, zaloMsgId: string): Promise<void> {
  try {
    await prisma.message.updateMany({
      where: { zaloMsgId: String(zaloMsgId) },
      data: { isDeleted: true, deletedAt: new Date() },
    });
    logger.info(`[message-handler] Undo message ${zaloMsgId} for account ${accountId}`);
  } catch (err) {
    logger.error('[message-handler] handleMessageUndo error:', err);
  }
}
