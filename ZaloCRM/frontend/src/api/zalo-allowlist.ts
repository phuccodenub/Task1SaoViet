/**
 * zalo-allowlist.ts — Client wrappers for the backend allowlist routes.
 *
 * All endpoints live under `/api/v1/zalo-accounts/:accountId/...` except the
 * conversation approve/reject pair which are scoped to a conversation id.
 *
 * Permission parity with backend (see `backend/src/modules/zalo/zalo-allowlist-routes.ts`):
 *   - `getAllowlist`, `bulkAllowlist`, `getAvailableThreads`, `approveConversation`,
 *     `rejectConversation`: requireZaloAccess('chat')
 *   - `patchIngestPolicy`: requireRole('owner','admin')
 */
import { api } from './index';

export type IngestPolicy = 'all' | 'allowlist';
export type ThreadType = 'user' | 'group';
export type ConversationVisibility = 'visible' | 'pending' | 'hidden';

export interface AllowlistItem {
  externalThreadId: string;
  threadType: ThreadType;
  enabled: boolean;
  note: string | null;
  addedByName: string | null;
  addedAt: string;
}

export interface AllowlistResponse {
  policy: IngestPolicy;
  items: AllowlistItem[];
}

export interface AvailableThread {
  externalThreadId: string;
  threadType: ThreadType;
  displayName: string;
  avatar: string;
  phone?: string;
  inAllowlist: boolean;
  allowlistEnabled: boolean;
  hasConversation: boolean;
  conversationId: string | null;
  conversationVisibility: ConversationVisibility | null;
  lastMessageAt: string | null;
}

export interface AvailableThreadsResponse {
  threads: AvailableThread[];
  cachedAt: number;
}

export interface BulkAllowlistBody {
  add?: Array<{ externalThreadId: string; threadType: ThreadType; note?: string }>;
  remove?: string[];
  enable?: string[];
  disable?: string[];
}

export interface BulkAllowlistResponse {
  added: number;
  removed: number;
  updated: number;
  hiddenConversations: number;
}

export async function getAllowlist(accountId: string): Promise<AllowlistResponse> {
  const res = await api.get(`/zalo-accounts/${accountId}/allowlist`);
  return res.data;
}

export async function patchIngestPolicy(
  accountId: string,
  policy: IngestPolicy,
): Promise<{ policy: IngestPolicy }> {
  const res = await api.patch(`/zalo-accounts/${accountId}/ingest-policy`, { policy });
  return res.data;
}

export async function bulkAllowlist(
  accountId: string,
  body: BulkAllowlistBody,
): Promise<BulkAllowlistResponse> {
  const res = await api.post(`/zalo-accounts/${accountId}/allowlist/bulk`, body);
  return res.data;
}

export async function getAvailableThreads(accountId: string): Promise<AvailableThreadsResponse> {
  const res = await api.get(`/zalo-accounts/${accountId}/available-threads`);
  return res.data;
}

export async function approveConversation(
  conversationId: string,
): Promise<{ success: boolean; conversationId: string; visibility: 'visible' }> {
  const res = await api.post(`/conversations/${conversationId}/approve`);
  return res.data;
}

export async function rejectConversation(
  conversationId: string,
): Promise<{ success: boolean; conversationId: string; visibility: 'hidden' }> {
  const res = await api.post(`/conversations/${conversationId}/reject`);
  return res.data;
}
