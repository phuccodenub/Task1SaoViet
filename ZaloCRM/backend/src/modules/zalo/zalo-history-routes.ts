/**
 * zalo-history-routes.ts — On-demand history backfill for conversations.
 *
 * POST /api/v1/conversations/:id/fetch-history
 *   Body: { batchSize?: number, maxBatches?: number }
 *
 * Currently supports group threads (threadType='group') via the zca-js
 * getGroupChatHistory API. 1-1 (user) thread history is deferred to phase 5
 * (api.custom() wrapper for the Zalo Web internal endpoint) — requests for
 * user threads return 400 until that lands.
 *
 * Pagination caveat (Fix #5): the SDK's getGroupChatHistory only takes
 * `count`, not a cursor. Successive batches can refetch the same newest
 * window, so we:
 *   - dedup at the row level (unique (conversationId, zaloMsgId))
 *   - only mark historyExhausted=true when upstream explicitly returns
 *     more=false (not when added=0) to avoid locking the UI button while
 *     older history is still reachable via cursor-aware wrappers (phase 5).
 *
 * Rate limiting:
 *   - 500ms delay between batches to avoid API throttling.
 *   - Hard cap: batchSize ≤ 200, maxBatches ≤ 10 per request.
 *
 * After each fetch the conversation's oldest_message_at and history_exhausted
 * fields are updated so the UI can render accurate "load more" state.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireZaloAccess } from './zalo-access-middleware.js';
import { zaloPool } from './zalo-pool.js';
import { fetchAndPersistGroupBatch } from './zalo-message-sync.js';
import { logger } from '../../shared/utils/logger.js';

interface FetchHistoryBody {
  batchSize?: number;
  maxBatches?: number;
}

const BATCH_DELAY_MS = 500;
const MAX_BATCH_SIZE = 200;
const MAX_BATCHES = 10;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_BATCHES = 1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function zaloHistoryRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  app.post('/api/v1/conversations/:id/fetch-history',
    { preHandler: requireZaloAccess('chat') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const body = (request.body || {}) as FetchHistoryBody;

      const batchSize = Math.min(Math.max(body.batchSize ?? DEFAULT_BATCH_SIZE, 1), MAX_BATCH_SIZE);
      const maxBatches = Math.min(Math.max(body.maxBatches ?? DEFAULT_MAX_BATCHES, 1), MAX_BATCHES);

      const conv = await prisma.conversation.findFirst({
        where: { id, orgId: user.orgId },
        select: {
          id: true,
          externalThreadId: true,
          threadType: true,
          zaloAccountId: true,
          historyExhausted: true,
          oldestMessageAt: true,
        },
      });
      if (!conv) return reply.status(404).send({ error: 'Conversation not found' });
      if (!conv.externalThreadId) {
        return reply.status(400).send({ error: 'Conversation has no external thread id' });
      }

      // Phase 4 covers group threads only; user threads wait for phase 5 (api.custom)
      if (conv.threadType !== 'group') {
        return reply.status(400).send({
          error: 'User (1-1) history fetch not yet available — waiting on phase 5',
          threadType: conv.threadType,
        });
      }

      if (conv.historyExhausted) {
        return { added: 0, exhausted: true, oldestMessageAt: conv.oldestMessageAt };
      }

      const instance = zaloPool.getInstance(conv.zaloAccountId);
      if (!instance?.api) {
        return reply.status(400).send({ error: 'Zalo account not connected' });
      }

      let totalAdded = 0;
      let exhausted = false;
      let lastMoreFlag = false;
      let oldestTsOverall: number | null = conv.oldestMessageAt?.getTime() ?? null;

      for (let i = 0; i < maxBatches; i++) {
        try {
          const result = await fetchAndPersistGroupBatch(
            instance.api,
            { id: conv.id, externalThreadId: conv.externalThreadId },
            conv.zaloAccountId,
            batchSize,
          );
          totalAdded += result.added;
          lastMoreFlag = result.more;

          if (result.oldestTs !== null) {
            if (oldestTsOverall === null || result.oldestTs < oldestTsOverall) {
              oldestTsOverall = result.oldestTs;
            }
          }

          // Only mark exhausted when Zalo itself says there's no more history.
          // added===0 alone is NOT sufficient: without cursor support the batch
          // often returns the same newest msgs that were already ingested by
          // the cron. Locking exhausted=true in that case would permanently
          // disable the UI button even though older history is still reachable
          // once phase 5 (api.custom cursor wrapper) lands.
          if (!result.more) {
            exhausted = true;
            break;
          }
          // If we got zero new rows but upstream says more, further batches in
          // this request will just refetch the same window — break early and
          // let the client try again later without marking exhausted.
          if (result.added === 0) break;
        } catch (err) {
          logger.warn(`[history] Fetch batch failed conv=${id}:`, err);
          // Don't mark exhausted on transient errors — let the client retry
          return reply.status(502).send({ error: 'Upstream Zalo API error', added: totalAdded });
        }

        if (i < maxBatches - 1) await sleep(BATCH_DELAY_MS);
      }

      // Persist progress so the UI can disable "Load more" when appropriate.
      // We only update historyExhausted when we're confident (see above).
      await prisma.conversation.update({
        where: { id },
        data: {
          historyExhausted: exhausted,
          oldestMessageAt: oldestTsOverall ? new Date(oldestTsOverall) : undefined,
        },
      });

      logger.info(
        `[history] conv=${id} account=${conv.zaloAccountId} added=${totalAdded} exhausted=${exhausted} moreUpstream=${lastMoreFlag}`,
      );
      return {
        added: totalAdded,
        exhausted,
        // Expose upstream 'more' flag so the client can distinguish "no cursor
        // support yet, try again later" from "Zalo says no more history".
        moreUpstream: lastMoreFlag,
        oldestMessageAt: oldestTsOverall ? new Date(oldestTsOverall) : null,
      };
    },
  );
}
