/**
 * zalo-socket.ts — Socket.IO authentication + room subscription.
 *
 * Security model (Fix #8):
 *   1. Every socket MUST present a valid JWT in `auth.token` or
 *      `Authorization` header during the Socket.IO handshake. Connections
 *      without a valid token are rejected before any event handler runs.
 *   2. orgId is taken from the verified JWT payload (NEVER from a client
 *      message) and the socket is auto-joined to `org:<orgId>`. This means
 *      the previous client-driven `org:join` event can be removed safely
 *      (server now does it for the client) and clients cannot impersonate
 *      another org by guessing an id.
 *   3. `zalo:subscribe` for per-account QR rooms re-checks org ownership +
 *      ZaloAccountAccess membership before joining `account:<id>`. Members
 *      without access (or owners/admins from other orgs) are denied.
 */
import type { Server, Socket } from 'socket.io';
import type { FastifyInstance } from 'fastify';
import { logger } from '../../shared/utils/logger.js';
import { prisma } from '../../shared/database/prisma-client.js';

interface AuthedSocket extends Socket {
  data: {
    userId: string;
    orgId: string;
    role: string;
  };
}

/**
 * Register Socket.IO authentication middleware + connection handlers.
 * Must be called BEFORE any io.on('connection') handler that depends on
 * socket.data being populated.
 */
export function registerZaloSocketHandlers(io: Server, app: FastifyInstance): void {
  // Authentication middleware — runs once per handshake
  io.use(async (socket, next) => {
    try {
      const token =
        (socket.handshake.auth as any)?.token ||
        (socket.handshake.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token) {
        return next(new Error('Unauthorized: missing token'));
      }
      // Verify against the Fastify JWT instance (same secret as REST auth)
      const payload = app.jwt.verify<{ id: string; orgId: string; role: string }>(token);
      if (!payload?.id || !payload?.orgId) {
        return next(new Error('Unauthorized: invalid token payload'));
      }
      socket.data.userId = payload.id;
      socket.data.orgId = payload.orgId;
      socket.data.role = payload.role;
      next();
    } catch (err) {
      logger.warn(`[socket] auth failed: ${err instanceof Error ? err.message : err}`);
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (rawSocket: Socket) => {
    const socket = rawSocket as AuthedSocket;
    // Auto-join the org room derived from the JWT — clients can no longer
    // pick an arbitrary orgId. This restores realtime delivery (Fix #7).
    socket.join(`org:${socket.data.orgId}`);
    logger.debug(`Socket ${socket.id} authed user=${socket.data.userId} org=${socket.data.orgId}`);

    // Subscribe to per-account QR/status events. We re-verify access here
    // even though org rooms already filter messages, because account:* is
    // the channel for QR codes and connection state — both sensitive.
    socket.on('zalo:subscribe', async (data: { accountId: string }) => {
      if (!data?.accountId) return;
      try {
        const account = await prisma.zaloAccount.findFirst({
          where: { id: data.accountId, orgId: socket.data.orgId },
          select: { id: true, ownerUserId: true },
        });
        if (!account) {
          logger.warn(
            `[socket] subscribe denied: user=${socket.data.userId} tried account=${data.accountId} (not in org=${socket.data.orgId})`,
          );
          return;
        }
        // Owner/admin auto-pass; account creator (ownerUserId) auto-pass for
        // legacy accounts created before Fix #15 added explicit access rows;
        // otherwise require an explicit ZaloAccountAccess row.
        const isPrivileged =
          socket.data.role === 'owner' ||
          socket.data.role === 'admin' ||
          account.ownerUserId === socket.data.userId;
        if (!isPrivileged) {
          const access = await prisma.zaloAccountAccess.findFirst({
            where: { zaloAccountId: data.accountId, userId: socket.data.userId },
            select: { id: true },
          });
          if (!access) {
            logger.warn(
              `[socket] subscribe denied: user=${socket.data.userId} no ZaloAccountAccess for account=${data.accountId}`,
            );
            return;
          }
        }
        socket.join(`account:${data.accountId}`);
        logger.debug(`Socket ${socket.id} joined account:${data.accountId}`);
      } catch (err) {
        logger.warn('[socket] subscribe error:', err);
      }
    });

    socket.on('zalo:unsubscribe', (data: { accountId: string }) => {
      if (!data?.accountId) return;
      socket.leave(`account:${data.accountId}`);
      logger.debug(`Socket ${socket.id} left account:${data.accountId}`);
    });

    socket.on('disconnect', () => {
      logger.debug(`Socket disconnected: ${socket.id}`);
    });
  });
}
