/**
 * conversation-history.ts — Clients for message history + "Tải thêm" flows.
 *
 * There are two distinct endpoints here, both different from the default
 * `GET /conversations/:id/messages?page=...`:
 *
 *   1. `loadMoreMessages(convId, beforeMsgId, limit)` — cursor over already
 *      persisted Message rows. Stable while new messages arrive at the tail.
 *      Used by MessageThread.vue load-more banner.
 *
 *   2. `fetchHistoryFromZalo(convId, { batchSize, maxBatches })` — asks the
 *      backend to call the live Zalo SDK for older messages that aren't in
 *      the DB yet. Currently group-only (server returns 400 for user threads
 *      until P5 lands). The response's `moreUpstream` flag is CRITICAL for
 *      the UI copy: because getGroupChatHistory has no cursor, `added=0`
 *      with `moreUpstream=true` means "Zalo still has more but we can't page
 *      past the recent window yet" — do NOT treat this as exhaustion.
 */
import { api } from './index';
import type { Message } from '@/composables/use-chat';

export interface LoadMoreMessagesResponse {
  messages: Message[];
  hasMore: boolean;
  oldestSentAt: string | null;
  limit: number;
}

/** Fetch messages strictly older than the given pivot message id (cursor pagination). */
export async function loadMoreMessages(
  conversationId: string,
  beforeMessageId: string,
  limit = 50,
): Promise<LoadMoreMessagesResponse> {
  const res = await api.get(`/conversations/${conversationId}/messages`, {
    params: { before: beforeMessageId, limit },
  });
  return res.data;
}

export interface FetchHistoryResponse {
  added: number;
  exhausted: boolean;
  /** Upstream Zalo SDK reported `more=true` on the last batch — older history
   *  may still be reachable once a cursor-aware wrapper lands (P5). */
  moreUpstream: boolean;
  oldestMessageAt: string | null;
}

export async function fetchHistoryFromZalo(
  conversationId: string,
  body: { batchSize?: number; maxBatches?: number } = {},
): Promise<FetchHistoryResponse> {
  const res = await api.post(`/conversations/${conversationId}/fetch-history`, body);
  return res.data;
}

export interface ConversationCounts {
  unread: number;
  unreplied: number;
  total: number;
  pending: number;
}

export async function getConversationCounts(
  params: { accountId?: string; tab?: string } = {},
): Promise<ConversationCounts> {
  const res = await api.get('/conversations/counts', { params });
  return res.data;
}
