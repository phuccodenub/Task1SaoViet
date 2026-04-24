/**
 * zalo-accessible-accounts.ts — Single source of truth for "which Zalo
 * accounts can a member see?"
 *
 * A member qualifies for access to a ZaloAccount via TWO independent paths:
 *   1. Explicit `ZaloAccountAccess` row (the normal grant flow)
 *   2. `ZaloAccount.ownerUserId === userId` (legacy fallback, matches the
 *      parity `requireZaloAccess` established in Fix #24 round 5)
 *
 * Without the ownerUserId branch, legacy accounts created before Fix #15
 * (when automatic access-row creation landed) would:
 *   - show up in /zalo-accounts list (because `zalo-routes.ts` filters with
 *     both access and ownerUserId)
 *   - pass `requireZaloAccess` middleware on direct endpoints (Fix #24)
 *   - but DISAPPEAR from `/conversations` list + counts (because those
 *     used only the ZaloAccountAccess filter) → the chat UI looked empty
 *     even though every other surface confirmed the account was visible.
 *
 * Callers should always use this resolver for list/count filters on member
 * requests. Owner/admin roles bypass the filter entirely at the route level
 * (they already have full org access).
 */
import { prisma } from '../../shared/database/prisma-client.js';

export interface AccessibleAccountsParams {
  userId: string;
  orgId: string;
}

/**
 * Return the union of accounts this member can access via either an
 * explicit ZaloAccountAccess row OR as the account's owner.
 *
 * Owner/admin roles should NOT call this — their callers skip the filter
 * altogether since they have full org access.
 */
export async function getAccessibleAccountIdsForMember(
  params: AccessibleAccountsParams,
): Promise<string[]> {
  const [accessRows, ownedRows] = await Promise.all([
    prisma.zaloAccountAccess.findMany({
      where: { userId: params.userId },
      select: { zaloAccountId: true },
    }),
    prisma.zaloAccount.findMany({
      where: { ownerUserId: params.userId, orgId: params.orgId },
      select: { id: true },
    }),
  ]);
  const ids = new Set<string>();
  for (const row of accessRows) ids.add(row.zaloAccountId);
  for (const row of ownedRows) ids.add(row.id);
  return Array.from(ids);
}
