/**
 * useConversationActions — Stateless composable exposing approve/reject and
 * history-fetching helpers so ChatView.vue and MobileChatView.vue share a
 * single code path.
 *
 * Deliberately stateless: the parent component (or `use-chat.ts`) owns the
 * conversation list + messages ref and decides when to refetch after a
 * successful mutation. This keeps the composable trivially reusable from
 * both the desktop and mobile chat views without coupling to either one's
 * refs.
 *
 * Related files:
 *   - `@/api/zalo-allowlist` (approve/reject endpoints)
 *   - `@/api/conversation-history` (cursor load-more + fetch-history from Zalo)
 */
import { ref } from 'vue';
import {
  approveConversation,
  rejectConversation,
} from '@/api/zalo-allowlist';
import {
  loadMoreMessages,
  fetchHistoryFromZalo,
  type LoadMoreMessagesResponse,
  type FetchHistoryResponse,
} from '@/api/conversation-history';

export function useConversationActions() {
  const approvingConv = ref<string | null>(null);
  const rejectingConv = ref<string | null>(null);
  const loadingMore = ref(false);
  const fetchingHistory = ref(false);

  async function approveConv(conversationId: string): Promise<boolean> {
    approvingConv.value = conversationId;
    try {
      await approveConversation(conversationId);
      return true;
    } catch (err: any) {
      console.error('[conversation-actions] approve failed:', err?.response?.data || err);
      return false;
    } finally {
      approvingConv.value = null;
    }
  }

  async function rejectConv(conversationId: string): Promise<boolean> {
    rejectingConv.value = conversationId;
    try {
      await rejectConversation(conversationId);
      return true;
    } catch (err: any) {
      console.error('[conversation-actions] reject failed:', err?.response?.data || err);
      return false;
    } finally {
      rejectingConv.value = null;
    }
  }

  /**
   * Load older messages from the DB using cursor pagination. The caller is
   * responsible for prepending the returned messages to its own list and
   * preserving scroll position.
   */
  async function loadMoreLocal(
    conversationId: string,
    beforeMessageId: string,
    limit = 50,
  ): Promise<LoadMoreMessagesResponse | null> {
    loadingMore.value = true;
    try {
      return await loadMoreMessages(conversationId, beforeMessageId, limit);
    } catch (err: any) {
      console.error('[conversation-actions] loadMoreLocal failed:', err?.response?.data || err);
      return null;
    } finally {
      loadingMore.value = false;
    }
  }

  /**
   * Ask the backend to pull older messages from the live Zalo SDK. Currently
   * group-only on the server. Returns `moreUpstream` so the caller can show a
   * trustworthy "có thể còn / đã hết" hint in the UI — group history has no
   * cursor yet so `added=0 + moreUpstream=true` is not the same as exhausted.
   */
  async function fetchHistory(
    conversationId: string,
    body: { batchSize?: number; maxBatches?: number } = {},
  ): Promise<FetchHistoryResponse | null> {
    fetchingHistory.value = true;
    try {
      return await fetchHistoryFromZalo(conversationId, body);
    } catch (err: any) {
      console.error('[conversation-actions] fetchHistory failed:', err?.response?.data || err);
      return null;
    } finally {
      fetchingHistory.value = false;
    }
  }

  return {
    approvingConv,
    rejectingConv,
    loadingMore,
    fetchingHistory,
    approveConv,
    rejectConv,
    loadMoreLocal,
    fetchHistory,
  };
}
