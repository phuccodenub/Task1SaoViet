/**
 * chat-routes.ts — REST API for conversations and messages.
 * All routes require JWT auth and are scoped to the user's org.
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireZaloAccess } from '../zalo/zalo-access-middleware.js';
import { getAccessibleAccountIdsForMember } from '../zalo/zalo-accessible-accounts.js';
import { zaloPool } from '../zalo/zalo-pool.js';
import { zaloRateLimiter } from '../zalo/zalo-rate-limiter.js';
import { logger } from '../../shared/utils/logger.js';
import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';

type QueryParams = Record<string, string>;

export async function chatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // ── Conversation filter counts (unread, unreplied, total, pending) ──────
  // NOTE: Must be registered BEFORE /api/v1/conversations/:id to avoid route conflict
  app.get('/api/v1/conversations/counts', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { accountId = '', tab = '' } = request.query as QueryParams;

    // Counts are scoped to visible conversations by default; pending is reported
    // separately so the UI can render a "Chờ duyệt" badge without double-counting.
    const baseWhere: any = { orgId: user.orgId, visibility: 'visible' };
    if (accountId) baseWhere.zaloAccountId = accountId;
    if (tab) baseWhere.tab = tab;

    // Members can only see conversations from Zalo accounts they have access to.
    // Round 12 P2: use the shared resolver so ownerUserId-matched legacy
    // accounts appear in the filter — without it the chat counts silently
    // dropped conversations that the account list + requireZaloAccess both
    // considered visible.
    if (user.role === 'member') {
      const accessibleIds = await getAccessibleAccountIdsForMember({
        userId: user.id,
        orgId: user.orgId,
      });
      if (accountId && accessibleIds.includes(accountId)) {
        baseWhere.zaloAccountId = accountId;
      } else {
        baseWhere.zaloAccountId = { in: accessibleIds };
      }
    }

    // Pending count ignores tab filter (pending convs aren't in main/other tabs yet)
    const pendingWhere: any = { ...baseWhere, visibility: 'pending' };
    delete pendingWhere.tab;

    const [unread, unreplied, total, pending] = await Promise.all([
      prisma.conversation.count({ where: { ...baseWhere, unreadCount: { gt: 0 } } }),
      prisma.conversation.count({ where: { ...baseWhere, isReplied: false } }),
      prisma.conversation.count({ where: baseWhere }),
      prisma.conversation.count({ where: pendingWhere }),
    ]);

    return { unread, unreplied, total, pending };
  });

  // ── List conversations (paginated, filterable) ──────────────────────────
  app.get('/api/v1/conversations', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const {
      page = '1',
      limit = '50',
      search = '',
      accountId = '',
      // Filter params
      unread = '',
      unreplied = '',
      from = '',
      to = '',
      tags = '',
      tab = '',
      // Visibility lifecycle — default 'visible' preserves v2.1 UI behavior
      visibility = 'visible',
    } = request.query as QueryParams;

    const where: any = { orgId: user.orgId };
    // Allow callers to opt out of the visibility filter by passing visibility='all'
    if (visibility && visibility !== 'all') where.visibility = visibility;
    if (tab) where.tab = tab;
    if (accountId) where.zaloAccountId = accountId;
    if (search) {
      where.contact = {
        OR: [
          { fullName: { contains: search, mode: 'insensitive' } },
          { crmName: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
        ],
      };
    }

    // Advanced filters
    if (unread === 'true') where.unreadCount = { gt: 0 };
    if (unreplied === 'true') where.isReplied = false;
    if (from || to) {
      where.lastMessageAt = {};
      if (from) {
        const d = new Date(from);
        if (!isNaN(d.getTime())) where.lastMessageAt.gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (!isNaN(d.getTime())) where.lastMessageAt.lte = d;
      }
      // Remove empty filter if both dates invalid
      if (Object.keys(where.lastMessageAt).length === 0) delete where.lastMessageAt;
    }
    if (tags) {
      const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean);
      if (tagList.length > 0) {
        // Merge with any existing contact filter from search
        where.contact = {
          ...where.contact,
          tags: { array_contains: tagList },
        };
      }
    }

    // Members can only see conversations from Zalo accounts they have access to.
    // Round 12 P2: shared resolver keeps list + counts in sync; ownerUserId
    // fallback preserves parity with /zalo-accounts list + requireZaloAccess.
    if (user.role === 'member') {
      const accessibleIds = await getAccessibleAccountIdsForMember({
        userId: user.id,
        orgId: user.orgId,
      });
      if (accountId && accessibleIds.includes(accountId)) {
        where.zaloAccountId = accountId;
      } else {
        where.zaloAccountId = { in: accessibleIds };
      }
    }

    const [conversations, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        include: {
          contact: { select: { id: true, fullName: true, crmName: true, phone: true, avatarUrl: true, zaloUid: true } },
          zaloAccount: { select: { id: true, displayName: true, zaloUid: true } },
          messages: {
            take: 1,
            orderBy: { sentAt: 'desc' },
            select: { content: true, contentType: true, senderType: true, sentAt: true, isDeleted: true },
          },
        },
        orderBy: { lastMessageAt: 'desc' },
        skip: (parseInt(page) - 1) * Math.min(parseInt(limit), 200),
        take: Math.min(parseInt(limit), 200),
      }),
      prisma.conversation.count({ where }),
    ]);

    return { conversations, total, page: parseInt(page), limit: Math.min(parseInt(limit), 200) };
  });

  // ── Get single conversation ──────────────────────────────────────────────
  app.get('/api/v1/conversations/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const conversation = await prisma.conversation.findFirst({
      where: { id, orgId: user.orgId },
      include: {
        contact: true,
        zaloAccount: { select: { id: true, displayName: true, zaloUid: true, status: true } },
      },
    });
    if (!conversation) return reply.status(404).send({ error: 'Not found' });

    return conversation;
  });

  // ── List messages for a conversation ────────────────────────────────────
  // Supports two pagination modes (backward-compat):
  //   1. Page-based: ?page=N&limit=L — default for initial load, returns total
  //   2. Cursor-based: ?before=<msgId>&limit=L — for "Tải thêm" in MessageThread.
  //      Returns messages strictly older than the pivot, newest→oldest in the
  //      query then reversed to oldest→newest for rendering. Clients use
  //      `hasMore` to decide whether to keep the button active.
  //
  // Cursor mode uses a COMPOSITE tie-break (sentAt desc, id desc) so that
  // messages sharing the pivot's sentAt aren't silently skipped. Round 12
  // Codex P2: `sentAt: { lt: pivot.sentAt }` alone would drop every row that
  // happened to share the pivot timestamp — load-more would then miss those
  // messages forever. The OR branch + composite ordering makes the cursor
  // deterministic across arbitrary timestamp collisions.
  app.get('/api/v1/conversations/:id/messages', { preHandler: requireZaloAccess('read') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const { page = '1', limit = '50', before = '' } = request.query as QueryParams;

    const take = Math.min(Math.max(parseInt(limit) || 50, 1), 200);

    const conversation = await prisma.conversation.findFirst({
      where: { id, orgId: user.orgId },
      select: { id: true },
    });
    if (!conversation) return reply.status(404).send({ error: 'Conversation not found' });

    if (before) {
      // Cursor mode: resolve the pivot to get both sentAt AND id so we can
      // break ties deterministically. Scope the lookup to this conversation
      // so callers can't probe ids from other conversations.
      const pivot = await prisma.message.findFirst({
        where: { id: before, conversationId: id },
        select: { id: true, sentAt: true },
      });
      if (!pivot) {
        return reply.status(400).send({ error: 'before message not found in this conversation' });
      }

      // Fetch one extra row beyond `take` so we can report hasMore without a
      // second COUNT query on a potentially hot table. The OR branch is the
      // tie-breaker for messages persisted at the exact same millisecond as
      // the pivot (common enough under high-throughput ingest that the
      // simpler strictly-less comparison dropped real data in round 11).
      const older = await prisma.message.findMany({
        where: {
          conversationId: id,
          OR: [
            { sentAt: { lt: pivot.sentAt } },
            { sentAt: pivot.sentAt, id: { lt: pivot.id } },
          ],
        },
        orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
      });
      const hasMore = older.length > take;
      const messages = (hasMore ? older.slice(0, take) : older).reverse();
      const oldestSentAt = messages[0]?.sentAt ?? null;

      return { messages, hasMore, oldestSentAt, limit: take };
    }

    const pageNum = Math.max(parseInt(page) || 1, 1);
    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where: { conversationId: id },
        orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
        skip: (pageNum - 1) * take,
        take,
      }),
      prisma.message.count({ where: { conversationId: id } }),
    ]);

    return { messages: messages.reverse(), total, page: pageNum, limit: take };
  });

  // ── Send message ─────────────────────────────────────────────────────────
  app.post('/api/v1/conversations/:id/messages', { preHandler: requireZaloAccess('chat') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const { content } = request.body as { content: string };

    if (!content?.trim()) return reply.status(400).send({ error: 'Content required' });

    const conversation = await prisma.conversation.findFirst({
      where: { id, orgId: user.orgId },
      include: { zaloAccount: true },
    });
    if (!conversation) return reply.status(404).send({ error: 'Conversation not found' });

    // Fix #11: block outbound send on non-visible conversations. Sending to a
    // hidden (rejected) or pending (awaiting review) thread would undermine
    // the allowlist contract — the thread was explicitly removed from CRM
    // sync or is still waiting for approval. User must approve/unhide first.
    if (conversation.visibility !== 'visible') {
      return reply.status(409).send({
        error:
          conversation.visibility === 'pending'
            ? 'Hội thoại đang chờ duyệt — vui lòng duyệt trước khi gửi'
            : 'Hội thoại đã bị ẩn — vui lòng khôi phục trước khi gửi',
        visibility: conversation.visibility,
      });
    }

    const instance = zaloPool.getInstance(conversation.zaloAccountId);
    if (!instance?.api) return reply.status(400).send({ error: 'Zalo account not connected' });

    // Reserve one outbound token atomically so concurrent sends cannot exceed quota.
    const limits = await zaloRateLimiter.reserveSend(conversation.zaloAccountId);
    if (!limits.allowed) {
      return reply.status(429).send({ error: limits.reason });
    }

    try {
      const threadId = conversation.externalThreadId || '';
      // zca-js sendMessage(message, threadId, type) — type: 0=User, 1=Group
      const threadType = conversation.threadType === 'group' ? 1 : 0;

      const sendResult = await instance.api.sendMessage({ msg: content }, threadId, threadType);
      // Extract zaloMsgId from sendMessage response for dedup with selfListen
      const zaloMsgId = String(sendResult?.msgId || sendResult?.data?.msgId || '');

      const message = await prisma.message.create({
        data: {
          id: randomUUID(),
          conversationId: id,
          zaloMsgId: zaloMsgId || null,
          senderType: 'self',
          senderUid: conversation.zaloAccount.zaloUid || '',
          senderName: 'Staff',
          content,
          contentType: 'text',
          sentAt: new Date(),
          repliedByUserId: user.id,
        },
      });

      await prisma.conversation.update({
        where: { id },
        data: { lastMessageAt: new Date(), isReplied: true, unreadCount: 0 },
      });

      const io = (app as any).io as Server;
      // CRM-sent messages always go through visible conversations (Fix #11
      // blocks sending on non-visible). Emit to the access-checked
      // `account:<id>` room so members without ZaloAccountAccess for this
      // account don't receive the message body — same boundary as REST.
      io?.to(`account:${conversation.zaloAccountId}`).emit('chat:message', {
        accountId: conversation.zaloAccountId,
        message,
        conversationId: id,
        visibility: 'visible',
      });

      return message;
    } catch (err) {
      logger.error('[chat] Send message error:', err);
      return reply.status(500).send({ error: 'Failed to send message' });
    }
  });

  // ── Mark conversation as read ────────────────────────────────────────────
  app.post('/api/v1/conversations/:id/mark-read', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    await prisma.conversation.updateMany({
      where: { id, orgId: user.orgId },
      data: { unreadCount: 0 },
    });

    return { success: true };
  });

  // ── Move conversation to a different tab (main / other) ────────────────
  app.patch('/api/v1/conversations/:id/tab', { preHandler: requireZaloAccess('chat') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const { tab } = request.body as { tab: string };

    if (!tab || !['main', 'other'].includes(tab)) {
      return reply.status(400).send({ error: 'tab must be "main" or "other"' });
    }

    const updated = await prisma.conversation.updateMany({
      where: { id, orgId: user.orgId },
      data: { tab },
    });

    if (updated.count === 0) return reply.status(404).send({ error: 'Conversation not found' });
    return { success: true, tab };
  });
}
