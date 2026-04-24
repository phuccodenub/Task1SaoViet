<template>
  <div class="mobile-chat" style="height: calc(100vh - 120px);">
    <!-- Conversation list (shown when no conversation selected) -->
    <div v-if="!selectedConvId" style="height: 100%;">
      <ConversationList
        ref="conversationListRef"
        :conversations="conversations"
        :selected-id="selectedConvId"
        :loading="loadingConvs"
        :approving-id="approvingConv"
        :rejecting-id="rejectingConv"
        :external-counts="counts"
        v-model:search="searchQuery"
        @select="selectConversation"
        @filter-account="onFilterAccount"
        @update:filters="onFiltersUpdate"
        @approve="onApprove"
        @reject="onReject"
      />
    </div>

    <!-- Message thread (shown when conversation selected) -->
    <div v-else style="height: 100%; display: flex; flex-direction: column;">
      <!-- Back button bar -->
      <div class="d-flex align-center pa-2" style="flex-shrink: 0;">
        <v-btn icon variant="text" size="small" @click="goBack">
          <v-icon>mdi-arrow-left</v-icon>
        </v-btn>
        <span v-if="selectedConv" class="text-body-2 font-weight-medium ml-1">
          {{ selectedConv.contact?.fullName || 'Chat' }}
        </span>
      </div>

      <MessageThread
        :conversation="selectedConv"
        :messages="allMessages"
        :loading="loadingMsgs"
        :sending="sendingMsg"
        :show-contact-panel="false"
        :ai-suggestion="(null as any)"
        :ai-suggestion-loading="false"
        :ai-suggestion-error="(null as any)"
        :total-messages="totalMessages"
        :loading-more="loadingMore"
        :fetching-history="fetchingHistory"
        :local-history-exhausted="localHistoryExhausted"
        :last-more-upstream="lastMoreUpstream"
        @send="handleSend"
        @load-more-local="loadMoreLocal"
        @fetch-history="fetchHistoryFromZalo"
        style="flex: 1; min-height: 0;"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, computed } from 'vue';
import ConversationList from '@/components/chat/ConversationList.vue';
import MessageThread from '@/components/chat/MessageThread.vue';
import { useChat } from '@/composables/use-chat';
import { useOfflineQueue } from '@/composables/use-offline-queue';

const {
  conversations, selectedConvId, selectedConv, messages,
  loadingConvs, loadingMsgs, sendingMsg, searchQuery, accountFilter, extraFilters,
  totalMessages, localHistoryExhausted, lastMoreUpstream,
  loadingMore, fetchingHistory, approvingConv, rejectingConv,
  counts,
  fetchConversations, selectConversation, sendMessage, sendMessageTo,
  initSocket, destroySocket, fetchCounts,
  loadMoreLocal, fetchHistoryFromZalo, approveConv, rejectConv,
} = useChat();

const conversationListRef = ref<InstanceType<typeof ConversationList> | null>(null);

const { pendingMessages, enqueue, flush } = useOfflineQueue();

function onFilterAccount(id: string | null) {
  accountFilter.value = id;
  fetchConversations();
  fetchCounts();
}

function onFiltersUpdate(params: Record<string, string>) {
  extraFilters.value = params;
  fetchConversations();
  fetchCounts();
}

async function onApprove(convId: string) {
  await approveConv(convId);
  conversationListRef.value?.fetchCounts?.();
}

async function onReject(convId: string) {
  await rejectConv(convId);
  conversationListRef.value?.fetchCounts?.();
}

function goBack() {
  selectedConvId.value = null;
}

// Merge real messages with pending offline messages
const allMessages = computed(() => {
  const pending = pendingMessages.value
    .filter(p => p.conversationId === selectedConvId.value)
    .map(p => ({
      id: p.id,
      content: p.content,
      contentType: 'text',
      senderType: 'self',
      senderName: null,
      sentAt: p.createdAt,
      isDeleted: false,
      zaloMsgId: null,
      _pending: true,
    }));
  return [...messages.value, ...pending];
});

async function handleSend(content: string) {
  if (!selectedConvId.value) return;
  if (!navigator.onLine) {
    enqueue(selectedConvId.value, content);
    return;
  }
  await sendMessage(content);
}

// Flush queue when coming back online
function onOnline() {
  flush(sendMessageTo);
}

onMounted(() => {
  fetchConversations();
  fetchCounts();
  initSocket();
  window.addEventListener('online', onOnline);
});

onUnmounted(() => {
  destroySocket();
  window.removeEventListener('online', onOnline);
  clearTimeout(searchTimeout);
});

let searchTimeout: ReturnType<typeof setTimeout>;
watch(searchQuery, () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => fetchConversations(), 300);
});
</script>
