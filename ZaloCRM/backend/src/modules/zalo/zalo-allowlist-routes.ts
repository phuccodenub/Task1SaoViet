/**
 * zalo-allowlist-routes.ts — CRUD for per-account thread allowlist + conversation review.
 *
 * Policy decisions enforced here:
 *   - Changing ingestPolicy is reserved for owner/admin (affects entire org's data).
 *   - Listing, bulk edits, and conversation approve/reject are available to
 *     members with chat permission on the Zalo account (requireZaloAccess('chat')).
 *   - Every mutating endpoint calls invalidateAllowlistCache() so the
 *     message-handler hot path sees fresh state within one request.
 *   - Every account-scoped handler re-verifies orgId ownership because
 *     requireZaloAccess bypasses the ZaloAccountAccess check for owner/admin.
 *     Without this re-check, an owner of org A could mutate org B's data by
 *     guessing a UUID.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireRole } from '../auth/role-middleware.js';
import { requireZaloAccess } from './zalo-access-middleware.js';
import { invalidateAllowlistCache } from './zalo-allowlist-cache.js';
import { listAvailableThreads, invalidateThreadListingCache } from './zalo-thread-listing.js';
import { logger } from '../../shared/utils/logger.js';
import { randomUUID } from 'node:crypto';

interface BulkBody {
  add?: Array<{ externalThreadId: string; threadType: 'user' | 'group'; note?: string }>;
  remove?: string[]; // externalThreadId
  enable?: string[];
  disable?: string[];
}

const MAX_BULK_ITEMS = 500;

/** Ensure the caller's org owns this Zalo account; returns true when safe. */
async function accountBelongsToOrg(accountId: string, orgId: string): Promise<boolean> {
  const found = await prisma.zaloAccount.findFirst({
    where: { id: accountId, orgId },
    select: { id: true },
  });
  return !!found;
}

export async function zaloAllowlistRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // ── GET allowlist + current policy ─────────────────────────────────────────
  app.get('/api/v1/zalo-accounts/:id/allowlist', { preHandler: requireZaloAccess('chat') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      // Re-verify org ownership: requireZaloAccess bypasses for owner/admin,
      // so without this check an owner of org A could read org B's data.
      const account = await prisma.zaloAccount.findFirst({
        where: { id, orgId: user.orgId },
        select: { ingestPolicy: true },
      });
      if (!account) return reply.status(404).send({ error: 'Account not found' });

      const items = await prisma.zaloThreadAllowlist.findMany({
        where: { zaloAccountId: id },
        orderBy: { createdAt: 'desc' },
        include: { addedBy: { select: { id: true, fullName: true } } },
      });

      return {
        policy: account.ingestPolicy,
        items: items.map((it) => ({
          externalThreadId: it.externalThreadId,
          threadType: it.threadType,
          enabled: it.enabled,
          note: it.note,
          addedByName: it.addedBy?.fullName ?? null,
          addedAt: it.createdAt,
        })),
      };
    },
  );

  // ── Change ingest policy (owner/admin only) ────────────────────────────────
  app.patch('/api/v1/zalo-accounts/:id/ingest-policy',
    { preHandler: requireRole('owner', 'admin') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const { policy } = request.body as { policy: 'all' | 'allowlist' };
      if (policy !== 'all' && policy !== 'allowlist') {
        return reply.status(400).send({ error: 'policy must be "all" or "allowlist"' });
      }
      const user = request.user!;
      const updated = await prisma.zaloAccount.updateMany({
        where: { id, orgId: user.orgId },
        data: { ingestPolicy: policy },
      });
      if (updated.count === 0) return reply.status(404).send({ error: 'Account not found' });

      invalidateAllowlistCache(id);
      // Thread listing shows policy + per-thread inAllowlist state — must
      // refresh when the policy itself flips so the UI reflects the new mode.
      invalidateThreadListingCache(id);
      logger.info(`[allowlist] account=${id} ingestPolicy=${policy} by user=${user.id}`);
      return { policy };
    },
  );

  // ── Bulk add/remove/enable/disable allowlist entries ──────────────────────
  app.post('/api/v1/zalo-accounts/:id/allowlist/bulk',
    { preHandler: requireZaloAccess('chat') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = (request.body || {}) as BulkBody;
      const user = request.user!;

      // Org scoping (see accountBelongsToOrg header comment)
      if (!(await accountBelongsToOrg(id, user.orgId))) {
        return reply.status(404).send({ error: 'Account not found' });
      }

      const totalOps =
        (body.add?.length ?? 0) +
        (body.remove?.length ?? 0) +
        (body.enable?.length ?? 0) +
        (body.disable?.length ?? 0);
      if (totalOps > MAX_BULK_ITEMS) {
        return reply.status(400).send({ error: `Max ${MAX_BULK_ITEMS} operations per request` });
      }

      let added = 0, removed = 0, updated = 0;
      // Collect threads that become "not allowed" so we can hide their
      // existing conversations below (Fix #6: untick must affect visible conv).
      const revokedThreads = new Set<string>();

      // Add — upsert so repeated calls are idempotent
      for (const item of body.add ?? []) {
        if (!item.externalThreadId || !item.threadType) continue;
        await prisma.zaloThreadAllowlist.upsert({
          where: {
            zaloAccountId_externalThreadId: {
              zaloAccountId: id,
              externalThreadId: item.externalThreadId,
            },
          },
          create: {
            id: randomUUID(),
            zaloAccountId: id,
            externalThreadId: item.externalThreadId,
            threadType: item.threadType,
            addedByUserId: user.id,
            note: item.note ?? null,
            enabled: true,
          },
          update: { enabled: true, note: item.note ?? undefined },
        });
        added++;
      }

      if (body.remove?.length) {
        const r = await prisma.zaloThreadAllowlist.deleteMany({
          where: { zaloAccountId: id, externalThreadId: { in: body.remove } },
        });
        removed = r.count;
        body.remove.forEach((t) => revokedThreads.add(t));
      }

      if (body.enable?.length) {
        const u = await prisma.zaloThreadAllowlist.updateMany({
          where: { zaloAccountId: id, externalThreadId: { in: body.enable } },
          data: { enabled: true },
        });
        updated += u.count;
      }

      if (body.disable?.length) {
        const u = await prisma.zaloThreadAllowlist.updateMany({
          where: { zaloAccountId: id, externalThreadId: { in: body.disable } },
          data: { enabled: false },
        });
        updated += u.count;
        body.disable.forEach((t) => revokedThreads.add(t));
      }

      // Fix #6 — revoking allowlist must stop existing ingest from leaking.
      // Flip affected visible conversations to 'hidden' with audit trail so
      // the untick UI matches user expectation ("chọn cái nào sync"). We
      // only target 'visible' rows so we don't overwrite 'pending' history.
      let hiddenConversations = 0;
      if (revokedThreads.size > 0) {
        const res = await prisma.conversation.updateMany({
          where: {
            zaloAccountId: id,
            externalThreadId: { in: [...revokedThreads] },
            visibility: 'visible',
          },
          data: {
            visibility: 'hidden',
            hiddenAt: new Date(),
            hiddenByUserId: user.id,
            reviewedAt: new Date(),
            reviewedByUserId: user.id,
          },
        });
        hiddenConversations = res.count;
      }

      invalidateAllowlistCache(id);
      // Bulk add/remove/disable changes which threads are inAllowlist and
      // also flips conv visibility on revoke — both feed /available-threads.
      invalidateThreadListingCache(id);
      return { added, removed, updated, hiddenConversations };
    },
  );

  // ── Approve pending conversation → visible + add to allowlist ─────────────
  app.post('/api/v1/conversations/:id/approve',
    { preHandler: requireZaloAccess('chat') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const conv = await prisma.conversation.findFirst({
        where: { id, orgId: user.orgId },
        select: {
          id: true,
          zaloAccountId: true,
          externalThreadId: true,
          threadType: true,
          visibility: true,
        },
      });
      if (!conv) return reply.status(404).send({ error: 'Conversation not found' });
      if (!conv.externalThreadId) {
        return reply.status(400).send({ error: 'Conversation has no external thread id' });
      }

      // Make visible + audit who approved it
      await prisma.conversation.update({
        where: { id },
        data: {
          visibility: 'visible',
          reviewedAt: new Date(),
          reviewedByUserId: user.id,
          hiddenAt: null,
          hiddenByUserId: null,
        },
      });

      // Upsert into allowlist so future messages from this thread stay visible
      await prisma.zaloThreadAllowlist.upsert({
        where: {
          zaloAccountId_externalThreadId: {
            zaloAccountId: conv.zaloAccountId,
            externalThreadId: conv.externalThreadId,
          },
        },
        create: {
          id: randomUUID(),
          zaloAccountId: conv.zaloAccountId,
          externalThreadId: conv.externalThreadId,
          threadType: conv.threadType,
          addedByUserId: user.id,
          enabled: true,
        },
        update: { enabled: true },
      });

      invalidateAllowlistCache(conv.zaloAccountId);
      // Approve adds an allowlist row + flips conv to visible — both visible
      // in /available-threads (inAllowlist + conversationVisibility).
      invalidateThreadListingCache(conv.zaloAccountId);
      return { success: true, conversationId: id, visibility: 'visible' };
    },
  );

  // ── Reject pending conversation → hidden (no allowlist entry) ─────────────
  app.post('/api/v1/conversations/:id/reject',
    { preHandler: requireZaloAccess('chat') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const conv = await prisma.conversation.findFirst({
        where: { id, orgId: user.orgId },
        select: { zaloAccountId: true },
      });
      const updated = await prisma.conversation.updateMany({
        where: { id, orgId: user.orgId },
        data: {
          visibility: 'hidden',
          hiddenAt: new Date(),
          hiddenByUserId: user.id,
          reviewedAt: new Date(),
          reviewedByUserId: user.id,
        },
      });
      if (updated.count === 0) return reply.status(404).send({ error: 'Conversation not found' });
      // Reject flips conversationVisibility → thread listing must refresh
      if (conv) invalidateThreadListingCache(conv.zaloAccountId);
      return { success: true, conversationId: id, visibility: 'hidden' };
    },
  );

  // ── List friends + groups from live Zalo SDK (5min cached) ────────────────
  app.get('/api/v1/zalo-accounts/:id/available-threads',
    { preHandler: requireZaloAccess('chat') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      // Org scoping (see accountBelongsToOrg header comment)
      if (!(await accountBelongsToOrg(id, user.orgId))) {
        return reply.status(404).send({ error: 'Account not found' });
      }
      try {
        const result = await listAvailableThreads(id, user.orgId);
        return result;
      } catch (err: any) {
        logger.warn(`[allowlist] available-threads error account=${id}:`, err);
        return reply.status(400).send({ error: err?.message ?? 'Failed to load threads' });
      }
    },
  );
}
