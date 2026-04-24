/**
 * Zalo account management routes.
 * All endpoints require authentication via authMiddleware.
 *
 * ACL parity with socket layer (Fix #20): the socket subscribe path enforces
 * org membership AND (owner/admin OR ownerUserId OR ZaloAccountAccess) before
 * a user can join an account room. The REST surface here mirrors that:
 *   - GET list: filtered to accessible accounts only (members don't see
 *     accounts they have no business with)
 *   - GET :id status: requireZaloAccess('read')
 *   - POST create: requireRole(owner|admin) — creating accounts is an
 *     organisational action, not something arbitrary members should trigger
 *   - POST :id/login, POST :id/reconnect, DELETE :id: requireZaloAccess('admin')
 *     — destructive/disruptive operations on the underlying Zalo session
 */
import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireRole } from '../auth/role-middleware.js';
import { requireZaloAccess } from './zalo-access-middleware.js';
import { zaloPool } from './zalo-pool.js';
import { prisma } from '../../shared/database/prisma-client.js';

export async function zaloRoutes(app: FastifyInstance): Promise<void> {
  // All routes in this plugin require auth
  app.addHook('preHandler', authMiddleware);

  // GET /api/v1/zalo-accounts — list accounts visible to caller.
  // Owner/admin see every account in the org; members only see accounts they
  // have an explicit ZaloAccountAccess row for OR own (ownerUserId match).
  app.get('/api/v1/zalo-accounts', async (request) => {
    const user = request.user!;

    let where: any = { orgId: user.orgId };
    if (user.role !== 'owner' && user.role !== 'admin') {
      const accessRows = await prisma.zaloAccountAccess.findMany({
        where: { userId: user.id },
        select: { zaloAccountId: true },
      });
      const accessibleIds = accessRows.map((r) => r.zaloAccountId);
      // Always include accounts the user owns (legacy accounts may lack
      // explicit access rows — see Fix #15 ownerUserId fallback).
      where = {
        orgId: user.orgId,
        OR: [
          { id: { in: accessibleIds } },
          { ownerUserId: user.id },
        ],
      };
    }

    const accounts = await prisma.zaloAccount.findMany({
      where,
      select: {
        id: true,
        zaloUid: true,
        displayName: true,
        avatarUrl: true,
        phone: true,
        status: true,
        lastConnectedAt: true,
        createdAt: true,
        owner: { select: { id: true, fullName: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Merge live status from pool
    return accounts.map((a) => ({
      ...a,
      liveStatus: zaloPool.getStatus(a.id),
    }));
  });

  // POST /api/v1/zalo-accounts — create a new account record.
  // Restricted to owner/admin: provisioning a Zalo account ties up org-level
  // resources and should not be a unilateral member action.
  app.post<{ Body: { displayName?: string } }>(
    '/api/v1/zalo-accounts',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const { displayName } = request.body ?? {};

      // Atomic: create account + grant creator explicit ZaloAccountAccess so
      // socket subscribe (which checks the access table) works immediately
      // without falling back to the ownerUserId path. (Fix #15.)
      const account = await prisma.$transaction(async (tx) => {
        const created = await tx.zaloAccount.create({
          data: {
            orgId: user.orgId,
            ownerUserId: user.id,
            displayName: displayName ?? null,
            status: 'qr_pending',
          },
        });
        await tx.zaloAccountAccess.create({
          data: {
            zaloAccountId: created.id,
            userId: user.id,
            permission: 'admin',
          },
        });
        return created;
      });

      return reply.status(201).send(account);
    },
  );

  // POST /api/v1/zalo-accounts/:id/login — initiate QR login.
  // Disruptive: invalidates any active session on the account. Require admin
  // permission on the specific account so members can't kick another team
  // member's session.
  app.post<{ Params: { id: string } }>(
    '/api/v1/zalo-accounts/:id/login',
    { preHandler: requireZaloAccess('admin') },
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user!;

      const account = await prisma.zaloAccount.findFirst({
        where: { id, orgId: user.orgId },
      });
      if (!account) {
        return reply.status(404).send({ error: 'Account not found' });
      }

      // Fire-and-forget — QR delivered via Socket.IO
      zaloPool.loginQR(id).catch(() => {
        // errors are emitted via socket; no need to crash here
      });

      return { message: 'QR login initiated — subscribe to account:' + id + ' socket room' };
    },
  );

  // POST /api/v1/zalo-accounts/:id/reconnect — force reconnect using saved session.
  // Same destructive-class as login; requires admin permission on the account.
  app.post<{ Params: { id: string } }>(
    '/api/v1/zalo-accounts/:id/reconnect',
    { preHandler: requireZaloAccess('admin') },
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user!;

      const account = await prisma.zaloAccount.findFirst({
        where: { id, orgId: user.orgId },
      });
      if (!account) {
        return reply.status(404).send({ error: 'Account not found' });
      }

      const session = account.sessionData as {
        cookie: any;
        imei: string;
        userAgent: string;
      } | null;

      if (!session?.imei) {
        return reply.status(400).send({ error: 'No saved session — please login with QR first' });
      }

      // Fire-and-forget — result emitted via Socket.IO
      zaloPool.reconnect(id, session).catch(() => {});

      return { message: 'Reconnect initiated' };
    },
  );

  // DELETE /api/v1/zalo-accounts/:id — disconnect and delete record.
  // Most destructive operation in this file → admin permission required.
  app.delete<{ Params: { id: string } }>(
    '/api/v1/zalo-accounts/:id',
    { preHandler: requireZaloAccess('admin') },
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user!;

      const account = await prisma.zaloAccount.findFirst({
        where: { id, orgId: user.orgId },
      });
      if (!account) {
        return reply.status(404).send({ error: 'Account not found' });
      }

      zaloPool.disconnect(id);
      await prisma.zaloAccount.delete({ where: { id } });

      return reply.status(204).send();
    },
  );

  // GET /api/v1/zalo-accounts/:id/status — live status from pool.
  // Read-only → minimum 'read' permission on the account.
  app.get<{ Params: { id: string } }>(
    '/api/v1/zalo-accounts/:id/status',
    { preHandler: requireZaloAccess('read') },
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user!;

      const account = await prisma.zaloAccount.findFirst({
        where: { id, orgId: user.orgId },
        select: { id: true, status: true },
      });
      if (!account) {
        return reply.status(404).send({ error: 'Account not found' });
      }

      return { accountId: id, liveStatus: zaloPool.getStatus(id) };
    },
  );
}
