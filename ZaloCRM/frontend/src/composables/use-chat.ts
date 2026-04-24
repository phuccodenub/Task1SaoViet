import { ref, computed } from 'vue';
import { api } from '@/api/index';
import { io, Socket } from 'socket.io-client';
import type { Contact } from '@/composables/use-contacts';
import { useConversationActions } from '@/composables/useConversationActions';
import { getConversationCounts, type ConversationCounts } from '@/api/conversation-history';

interface ZaloAccount {
  id: string;
  displayName: string | null;
}

export interface AiSentiment {
  label: 'positive' | 'neutral' | 'negative';
  confidence: number;
  reason: string;
}

export interface AiConfig {
  provider: string;
  model: string;
  maxDaily: number;
  enabled: boolean;
  hasAnthropicKey?: boolean;
  hasGeminiKey?: boolean;
}

interface ConversationMessage {
  content: string | null;
  contentType: string;
  senderType: string;
  sentAt: string;
  isDeleted: boolean;
}

export interface Conversation {
  id: string;
  threadType: 'user' | 'group';
  contact: Contact | null;
  zaloAccount: ZaloAccount | null;
  lastMessageAt: string | null;
  unreadCount: number;
  isReplied: boolean;
  /** Lifecycle state — driven by ingestPolicy + allowlist. Default 'visible' for legacy rows. */
  visibility?: 'visible' | 'pending' | 'hidden';
  /** True when the backend confirmed upstream Zalo returned more=false for this conversation's history.
   *  Cursor pagination over the Message table is still possible even when this is true. */
  historyExhausted?: boolean;
  oldestMessageAt?: string | null;
  messages?: ConversationMessage[];
}

export interface Message {
  id: string;
  content: string | null;
  contentType: string;
  senderType: string;
  senderName: string | null;
  sentAt: string;
  isDeleted: boolean;
  zaloMsgId: string | null;
}

export function useChat() {
  const conversations = ref<Conversation[]>([]);
  const selectedConvId = ref<string | null>(null);
  const messages = ref<Message[]>([]);
  const loadingConvs = ref(false);
  const loadingMsgs = ref(false);
  const sendingMsg = ref(false);
  const searchQuery = ref('');
  const accountFilter = ref<string | null>(null);
  const aiSuggestion = ref('');
  const aiSuggestionLoading = ref(false);
  const aiSuggestionError = ref('');
  const aiSummary = ref('');
  const aiSummaryLoading = ref(false);
  const aiSentiment = ref<AiSentiment | null>(null);
  const aiSentimentLoading = ref(false);
  const aiUsage = ref({ usedToday: 0, maxDaily: 500, remaining: 500, enabled: true });
  const aiConfig = ref<AiConfig>({ provider: 'anthropic', model: 'claude-sonnet-4-6', maxDaily: 500, enabled: true });
  const counts = ref<ConversationCounts>({ unread: 0, unreplied: 0, total: 0, pending: 0 });
  /** Server-reported total message count for the currently selected conversation.
   *  Drives the "Tải thêm" banner — when messages.length < totalMessages we can
   *  cursor-load from the DB without hitting the Zalo SDK. */
  const totalMessages = ref(0);
  /** True when the last DB cursor fetch reported hasMore=false (exhausted locally). */
  const localHistoryExhausted = ref(false);
  const lastMoreUpstream = ref<boolean | null>(null);
  let socket: Socket | null = null;

  const actions = useConversationActions();

  const selectedConv = computed(() =>
    conversations.value.find(c => c.id === selectedConvId.value) || null,
  );

  function clearAiState() {
    aiSuggestion.value = '';
    aiSuggestionError.value = '';
    aiSummary.value = '';
    aiSentiment.value = null;
  }

  const extraFilters = ref<Record<string, string>>({});

  async function fetchConversations() {
    loadingConvs.value = true;
    try {
      const res = await api.get('/conversations', {
        params: {
          limit: 100,
          search: searchQuery.value,
          accountId: accountFilter.value || undefined,
          ...extraFilters.value,
        },
      });
      conversations.value = res.data.conversations;
    } catch (err) {
      console.error('Failed to fetch conversations:', err);
    } finally {
      loadingConvs.value = false;
    }
  }

  async function fetchMessages(convId: string) {
    loadingMsgs.value = true;
    try {
      const res = await api.get(`/conversations/${convId}/messages`, {
        params: { limit: 100 },
      });
      messages.value = res.data.messages;
      totalMessages.value = res.data.total ?? messages.value.length;
      // Fresh list — reset cursor exhaustion; only the latest load-more call
      // can set localHistoryExhausted=true.
      localHistoryExhausted.value = false;
      lastMoreUpstream.value = null;
    } catch (err) {
      console.error('Failed to fetch messages:', err);
    } finally {
      loadingMsgs.value = false;
    }
  }

  async function fetchCounts() {
    try {
      const params: { accountId?: string; tab?: string } = {};
      if (accountFilter.value) params.accountId = accountFilter.value;
      if (extraFilters.value.tab) params.tab = extraFilters.value.tab;
      counts.value = await getConversationCounts(params);
    } catch {
      // Counts are a UX nicety, not a source of truth — silent failure is fine
    }
  }

  /**
   * Prepend older messages from the DB using cursor pagination. Safe to call
   * while new messages arrive at the tail because cursor is message-id based
   * (not offset-based). Returns true if at least one new message was prepended.
   */
  async function loadMoreLocal(): Promise<boolean> {
    const convId = selectedConvId.value;
    if (!convId) return false;
    if (localHistoryExhausted.value) return false;
    const oldest = messages.value[0];
    if (!oldest) return false;

    const res = await actions.loadMoreLocal(convId, oldest.id, 50);
    if (!res) return false;
    if (res.messages.length === 0) {
      localHistoryExhausted.value = true;
      return false;
    }
    // Prepend — existing message ids are unique, so no dedup needed
    messages.value = [...res.messages, ...messages.value];
    if (!res.hasMore) localHistoryExhausted.value = true;
    return true;
  }

  /**
   * Ask the backend to pull older messages for the selected conversation from
   * the live Zalo SDK. Group only on the server; user threads will return 400
   * until P5 lands. On success we refetch the message list so any newly-
   * persisted rows appear. `lastMoreUpstream` tells the caller whether Zalo
   * itself still has more history (used by the banner copy).
   */
  async function fetchHistoryFromZalo(
    opts: { batchSize?: number; maxBatches?: number } = {},
  ): Promise<{ added: number; exhausted: boolean; moreUpstream: boolean } | null> {
    const convId = selectedConvId.value;
    if (!convId) return null;
    const res = await actions.fetchHistory(convId, { batchSize: 50, maxBatches: 1, ...opts });
    if (!res) return null;
    lastMoreUpstream.value = res.moreUpstream;

    // Mirror historyExhausted onto the in-memory conversation so UI updates
    // immediately without waiting for the next full list fetch.
    const conv = conversations.value.find((c) => c.id === convId);
    if (conv) {
      conv.historyExhausted = res.exhausted;
      conv.oldestMessageAt = res.oldestMessageAt ?? conv.oldestMessageAt;
    }

    if (res.added > 0) {
      await fetchMessages(convId);
    }
    return { added: res.added, exhausted: res.exhausted, moreUpstream: res.moreUpstream };
  }

  async function approveConv(convId: string): Promise<boolean> {
    const ok = await actions.approveConv(convId);
    if (ok) {
      // Refresh list + counts so the pending badge + main tab update
      await Promise.all([fetchConversations(), fetchCounts()]);
    }
    return ok;
  }

  async function rejectConv(convId: string): Promise<boolean> {
    const ok = await actions.rejectConv(convId);
    if (ok) {
      // Remove the rejected conv from the current view so the user gets
      // immediate feedback without waiting for the list refresh
      conversations.value = conversations.value.filter((c) => c.id !== convId);
      if (selectedConvId.value === convId) {
        selectedConvId.value = null;
        messages.value = [];
      }
      await fetchCounts();
    }
    return ok;
  }

  async function fetchAiConfig() {
    try {
      const res = await api.get('/ai/config');
      aiConfig.value = {
        provider: res.data.provider,
        model: res.data.model,
        maxDaily: res.data.maxDaily,
        enabled: res.data.enabled,
        hasAnthropicKey: res.data.hasAnthropicKey,
        hasGeminiKey: res.data.hasGeminiKey,
      };
    } catch (err) {
      console.error('Failed to fetch AI config:', err);
    }
  }

  async function saveAiConfig(payload: AiConfig) {
    const res = await api.put('/ai/config', payload);
    aiConfig.value = {
      provider: res.data.provider,
      model: res.data.model,
      maxDaily: res.data.maxDaily,
      enabled: res.data.enabled,
      hasAnthropicKey: aiConfig.value.hasAnthropicKey,
      hasGeminiKey: aiConfig.value.hasGeminiKey,
    };
  }

  async function fetchAiUsage() {
    try {
      const res = await api.get('/ai/usage');
      aiUsage.value = res.data;
    } catch (err) {
      console.error('Failed to fetch AI usage:', err);
    }
  }

  async function generateAiSuggestion() {
    if (!selectedConvId.value) return;
    aiSuggestionLoading.value = true;
    aiSuggestionError.value = '';
    try {
      const res = await api.post('/ai/suggest', { conversationId: selectedConvId.value });
      aiSuggestion.value = res.data.content || '';
      await fetchAiUsage();
    } catch (err: any) {
      aiSuggestionError.value = err.response?.data?.error || 'Không thể tạo gợi ý AI';
    } finally {
      aiSuggestionLoading.value = false;
    }
  }

  async function generateAiSummary() {
    if (!selectedConvId.value) return;
    aiSummaryLoading.value = true;
    try {
      const res = await api.post(`/ai/summarize/${selectedConvId.value}`);
      aiSummary.value = res.data.content || '';
      await fetchAiUsage();
    } catch (err) {
      console.error('Failed to summarize conversation:', err);
    } finally {
      aiSummaryLoading.value = false;
    }
  }

  async function generateAiSentiment() {
    if (!selectedConvId.value) return;
    aiSentimentLoading.value = true;
    try {
      const res = await api.post(`/ai/sentiment/${selectedConvId.value}`);
      aiSentiment.value = res.data;
      await fetchAiUsage();
    } catch (err) {
      console.error('Failed to analyze sentiment:', err);
    } finally {
      aiSentimentLoading.value = false;
    }
  }

  async function selectConversation(convId: string) {
    selectedConvId.value = convId;
    clearAiState();
    await fetchMessages(convId);
    try {
      const convDetail = await api.get(`/conversations/${convId}`);
      const conv = conversations.value.find(c => c.id === convId);
      if (conv && convDetail.data.contact) {
        conv.contact = convDetail.data.contact;
      }
    } catch {
      // Non-critical
    }
    try {
      await api.post(`/conversations/${convId}/mark-read`);
      const conv = conversations.value.find(c => c.id === convId);
      if (conv) conv.unreadCount = 0;
    } catch {
      // Ignore mark-read errors
    }
    await Promise.allSettled([generateAiSummary(), generateAiSentiment(), fetchAiUsage()]);
  }

  async function sendMessage(content: string) {
    if (!selectedConvId.value || !content.trim()) return;
    await sendMessageTo(selectedConvId.value, content);
  }

  async function sendMessageTo(conversationId: string, content: string) {
    if (!content.trim()) return;
    sendingMsg.value = true;
    try {
      const res = await api.post(`/conversations/${conversationId}/messages`, { content });
      if (conversationId === selectedConvId.value) {
        if (!messages.value.find(m => m.id === res.data.id)) {
          messages.value.push(res.data);
        }
      }
    } catch (err) {
      console.error('Failed to send message:', err);
      throw err;
    } finally {
      sendingMsg.value = false;
    }
  }

  function initSocket() {
    // Pass JWT in handshake auth so backend can verify identity + auto-join
    // org room (Fix #7/#8 — privacy fix would otherwise drop chat:message
    // events because we never join the org room from the client).
    const token = localStorage.getItem('token') || '';
    socket = io({
      transports: ['websocket', 'polling'],
      auth: { token },
    });

    // Subscribe to per-account rooms for every account the user can access.
    // Visible-payload chat:message events are now emitted to `account:<id>`
    // instead of `org:<orgId>` (Fix #13) — org room only gets pending
    // envelopes, so without this subscribe the UI would never see live
    // messages. Backend re-verifies access on each subscribe.
    socket.on('connect', async () => {
      try {
        const { data } = await api.get('/zalo-accounts');
        const accounts = data?.accounts || data || [];
        for (const acc of accounts) {
          if (acc?.id) socket?.emit('zalo:subscribe', { accountId: acc.id });
        }
      } catch (err) {
        console.warn('[chat] failed to subscribe to account rooms:', err);
      }
    });

    // Discriminated handler:
    //   - pending envelope (Fix #19) carries only {accountId, visibility};
    //     refetch the per-account counters and conversation list so the
    //     "Chờ duyệt" badge updates. No conv/message ids leak from server.
    //   - visible payload behaves like before.
    socket.on('chat:message', (data: any) => {
      if (data?.visibility === 'pending') {
        // Counts badge matters more than the list here — the pending envelope
        // does not carry enough metadata to render a row, user opens the
        // allowlist view to triage.
        fetchCounts();
        fetchConversations();
        return;
      }
      if (data?.message && data.conversationId === selectedConvId.value) {
        if (!messages.value.find(m => m.id === data.message.id)) {
          messages.value.push(data.message);
          totalMessages.value += 1;
        }
      }
      fetchConversations();
      fetchCounts();
    });

    socket.on('chat:deleted', (data: { msgId: string }) => {
      const msg = messages.value.find(m => m.zaloMsgId === data.msgId);
      if (msg) msg.isDeleted = true;
    });
  }

  function destroySocket() {
    socket?.disconnect();
    socket = null;
  }

  return {
    conversations,
    selectedConvId,
    selectedConv,
    messages,
    loadingConvs,
    loadingMsgs,
    sendingMsg,
    searchQuery,
    accountFilter,
    extraFilters,
    aiSuggestion,
    aiSuggestionLoading,
    aiSuggestionError,
    aiSummary,
    aiSummaryLoading,
    aiSentiment,
    aiSentimentLoading,
    aiUsage,
    aiConfig,
    counts,
    totalMessages,
    localHistoryExhausted,
    lastMoreUpstream,
    fetchConversations,
    fetchAiConfig,
    saveAiConfig,
    fetchAiUsage,
    selectConversation,
    sendMessage,
    sendMessageTo,
    generateAiSuggestion,
    generateAiSummary,
    generateAiSentiment,
    clearAiState,
    initSocket,
    destroySocket,
    fetchCounts,
    loadMoreLocal,
    fetchHistoryFromZalo,
    approveConv,
    rejectConv,
    loadingMore: actions.loadingMore,
    fetchingHistory: actions.fetchingHistory,
    approvingConv: actions.approvingConv,
    rejectingConv: actions.rejectingConv,
  };
}
