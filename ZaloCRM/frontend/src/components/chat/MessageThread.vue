<template>
  <div class="message-thread d-flex flex-column flex-grow-1" style="height: 100%;">
    <!-- Empty state -->
    <div v-if="!conversation" class="d-flex align-center justify-center flex-grow-1">
      <div class="text-center text-grey">
        <v-icon icon="mdi-chat-outline" size="96" color="grey-lighten-2" />
        <p class="text-h6 mt-4">Chọn cuộc trò chuyện</p>
      </div>
    </div>

    <template v-else>
      <!-- Header -->
      <div class="pa-3 d-flex align-center" style="border-bottom: 1px solid var(--border-glow, rgba(0,242,255,0.1));">
        <v-avatar size="36" color="grey-lighten-2" class="mr-3">
          <v-icon v-if="conversation.threadType === 'group'" icon="mdi-account-group" />
          <v-img v-else-if="conversation.contact?.avatarUrl" :src="conversation.contact.avatarUrl" />
          <v-icon v-else icon="mdi-account" />
        </v-avatar>
        <div class="flex-grow-1">
          <div class="font-weight-medium">{{ conversation.contact?.fullName || 'Unknown' }}</div>
          <div class="text-caption text-grey">{{ conversation.zaloAccount?.displayName || 'Zalo' }}</div>
        </div>
        <v-btn size="small" variant="tonal" color="primary" class="mr-2" :loading="aiSuggestionLoading" @click="$emit('ask-ai')">
          Ask AI
        </v-btn>
        <v-btn
          :icon="showContactPanel ? 'mdi-account-details' : 'mdi-account-details-outline'"
          size="small" variant="text"
          :color="showContactPanel ? 'primary' : undefined"
          @click="$emit('toggle-contact-panel')"
        />
      </div>

      <!-- Messages -->
      <div ref="messagesContainer" class="flex-grow-1 overflow-y-auto pa-3 chat-messages-area">
        <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-2" />

        <!-- History banner: top of the thread so "Tải thêm" is where users
             expect it (native Zalo UX). Copy is deliberately conservative —
             the backend SDK has no cursor for group history, so dedup
             protects us but we cannot promise true pagination. -->
        <div
          v-if="showHistoryBanner"
          class="history-banner"
          :class="{ 'history-banner-exhausted': historyFullyExhausted }"
        >
          <v-progress-linear
            v-if="loadingMore || fetchingHistory"
            indeterminate
            color="primary"
            class="mb-1"
            height="2"
          />
          <div class="d-flex align-center justify-center flex-column">
            <v-btn
              v-if="!historyFullyExhausted"
              size="small"
              variant="tonal"
              color="primary"
              :loading="loadingMore || fetchingHistory"
              :disabled="loadingMore || fetchingHistory"
              prepend-icon="mdi-arrow-up"
              @click="onLoadMoreClick"
            >
              {{ loadMoreButtonLabel }}
            </v-btn>
            <span v-else class="text-caption text-grey-darken-1">
              <v-icon icon="mdi-check-circle-outline" size="14" class="mr-1" />
              Đã tải hết lịch sử khả dụng
            </span>
            <div v-if="bannerHint" class="text-caption text-grey mt-1">
              {{ bannerHint }}
            </div>
          </div>
        </div>

        <div v-for="msg in messages" :key="msg.id" class="mb-2 d-flex" :class="msg.senderType === 'self' ? 'justify-end' : 'justify-start'">
          <div style="max-width: 70%;">
            <div v-if="conversation.threadType === 'group' && msg.senderType !== 'self'" class="text-caption mb-1" style="color: #00F2FF; font-weight: 500;">
              {{ msg.senderName || 'Unknown' }}
            </div>
            <div class="message-bubble pa-2 px-3 rounded-lg" :class="msg.senderType === 'self' ? 'bg-primary text-white' : 'bg-white'" style="word-wrap: break-word;">
              <!-- Deleted -->
              <div v-if="msg.isDeleted" class="text-decoration-line-through font-italic" style="opacity: 0.6;">
                {{ msg.content || '(tin nhắn)' }}<span class="text-caption"> (đã thu hồi)</span>
              </div>
              <!-- Image -->
              <div v-else-if="getImageUrl(msg)">
                <img :src="getImageUrl(msg)!" alt="Hình ảnh" class="chat-image" @click="previewImageUrl = getImageUrl(msg)!" />
              </div>
              <!-- File/PDF -->
              <div v-else-if="getFileInfo(msg)" class="file-card">
                <v-icon size="20" class="mr-2" color="info">mdi-file-document-outline</v-icon>
                <div class="flex-grow-1">
                  <div class="text-body-2 font-weight-medium">{{ getFileInfo(msg)!.name }}</div>
                  <div class="text-caption" style="opacity: 0.6;">{{ getFileInfo(msg)!.size }}</div>
                </div>
                <v-btn v-if="getFileInfo(msg)!.href" icon size="x-small" variant="text" @click="openFile(getFileInfo(msg)!.href)">
                  <v-icon size="16">mdi-download</v-icon>
                </v-btn>
              </div>
              <!-- Sticker/Video/Voice/GIF -->
              <div v-else-if="msg.contentType === 'sticker'">🏷️ Sticker</div>
              <div v-else-if="msg.contentType === 'video'">🎥 Video</div>
              <div v-else-if="msg.contentType === 'voice'">🎤 Tin nhắn thoại</div>
              <div v-else-if="msg.contentType === 'gif'">GIF</div>
              <!-- Reminder/Calendar (legacy inline renderer kept for backward compat) -->
              <div v-else-if="isReminderMessage(msg)" class="reminder-card">
                <div class="d-flex align-center mb-1">
                  <v-icon size="16" color="warning" class="mr-1">mdi-calendar-clock</v-icon>
                  <span class="text-caption font-weight-bold" style="color: #FFB74D;">Nhắc hẹn</span>
                </div>
                <div class="text-body-2">{{ getReminderTitle(msg) }}</div>
                <div v-if="getReminderTime(msg)" class="text-caption mt-1" style="opacity: 0.7;">
                  <v-icon size="12" class="mr-1">mdi-clock-outline</v-icon>{{ getReminderTime(msg) }}
                </div>
                <v-btn size="x-small" variant="tonal" color="warning" class="mt-2" prepend-icon="mdi-calendar-sync" @click="syncAppointment(msg)">
                  Đồng bộ lịch
                </v-btn>
              </div>
              <!-- Special message types (bank_transfer, call, qr_code, poll, note, forwarded, rich) -->
              <SpecialMessageRenderer
                v-else-if="isSpecialType(msg.contentType)"
                :type="msg.contentType"
                :content="parseContent(msg.content)"
              />
              <!-- Default text -->
              <div v-else>{{ parseDisplayContent(msg.content) }}</div>
              <!-- Timestamp -->
              <div class="text-caption mt-1 msg-time" :class="msg.senderType === 'self' ? 'msg-time-self' : 'msg-time-contact'" style="font-size: 0.7rem;">
                {{ formatMessageTime(msg.sentAt) }}
              </div>
            </div>
          </div>
        </div>
        <div v-if="!loading && messages.length === 0" class="text-center pa-8 text-grey">Chưa có tin nhắn</div>
      </div>

      <!-- Input -->
      <div class="pa-2 chat-input-area">
        <AiSuggestionPanel
          :suggestion="aiSuggestion"
          :loading="aiSuggestionLoading"
          :error="aiSuggestionError"
          @generate="$emit('ask-ai')"
          @apply="applySuggestion"
        />
        <div class="d-flex align-end" style="position: relative;">
          <QuickTemplatePopup
            ref="popupRef"
            :visible="showTemplatePopup"
            :query="templateQuery"
            :templates="templates"
            :contact="conversation.contact"
            @select="onTemplateSelect"
            @close="showTemplatePopup = false"
          />
          <v-textarea
            v-model="inputText"
            placeholder="Nhập tin nhắn... (gõ / để chèn mẫu)"
            variant="solo-filled"
            density="compact"
            hide-details
            auto-grow
            rows="1"
            max-rows="3"
            class="flex-grow-1 mr-2"
            @input="onInput"
            @keydown="onInputKeydown"
            @keydown.enter.exact.prevent="handleSend"
          />
          <v-btn icon color="primary" :loading="sending" :disabled="!inputText.trim()" @click="handleSend">
            <v-icon>mdi-send</v-icon>
          </v-btn>
        </div>
      </div>
    </template>

    <!-- Image preview dialog -->
    <v-dialog v-model="showImagePreview" max-width="900" content-class="elevation-0">
      <div class="text-center" @click="showImagePreview = false" style="cursor: pointer;">
        <img :src="previewImageUrl" alt="Preview" style="max-width: 100%; max-height: 85vh; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);" />
        <div class="text-caption mt-2" style="color: #aaa;">Nhấn để đóng</div>
      </div>
    </v-dialog>

    <!-- Sync snackbar -->
    <v-snackbar v-model="syncSnack.show" :color="syncSnack.color" timeout="3000">{{ syncSnack.text }}</v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted } from 'vue';
import type { Conversation, Message } from '@/composables/use-chat';
import { api } from '@/api/index';
import AiSuggestionPanel from '@/components/ai/ai-suggestion-panel.vue';
import SpecialMessageRenderer from '@/components/chat/special-message-renderer.vue';
import QuickTemplatePopup from '@/components/chat/quick-template-popup.vue';

interface TemplateItem {
  id: string;
  name: string;
  content: string;
  category: string | null;
  isPersonal: boolean;
}

const props = defineProps<{
  conversation: Conversation | null;
  messages: Message[];
  loading: boolean;
  sending: boolean;
  showContactPanel?: boolean;
  aiSuggestion: string;
  aiSuggestionLoading: boolean;
  aiSuggestionError: string;
  /** Total message count reported by the server on the last full fetch. Used
   *  to decide whether we can still cursor-load from the DB. */
  totalMessages?: number;
  /** In-flight flags driven by the parent composable. */
  loadingMore?: boolean;
  fetchingHistory?: boolean;
  /** True when the last cursor fetch returned hasMore=false. */
  localHistoryExhausted?: boolean;
  /** Last known value of the server-reported `moreUpstream` flag from
   *  fetch-history. Lets the banner say "Zalo còn lịch sử cũ hơn" vs
   *  "Zalo đã hết" without lying about SDK cursor limitations. */
  lastMoreUpstream?: boolean | null;
}>();

const emit = defineEmits<{
  send: [content: string];
  'toggle-contact-panel': [];
  'ask-ai': [];
  'load-more-local': [];
  'fetch-history': [];
}>();

const inputText = ref('');
const messagesContainer = ref<HTMLElement | null>(null);
const previewImageUrl = ref('');
const showImagePreview = computed({ get: () => !!previewImageUrl.value, set: (v) => { if (!v) previewImageUrl.value = ''; } });
const syncSnack = ref({ show: false, text: '', color: 'success' });

// Content types handled by SpecialMessageRenderer
const SPECIAL_TYPES = new Set([
  'bank_transfer', 'call', 'qr_code', 'reminder', 'poll', 'note', 'forwarded', 'rich',
]);

function isSpecialType(contentType: string | null | undefined): boolean {
  return !!contentType && SPECIAL_TYPES.has(contentType);
}

/** Safely parse JSON content for SpecialMessageRenderer; returns raw string on failure. */
function parseContent(content: string | null): unknown {
  if (!content) return null;
  try { return JSON.parse(content); } catch { return content; }
}

// --- Template quick-insert ---
const showTemplatePopup = ref(false);
const templateQuery = ref('');
const templates = ref<TemplateItem[]>([]);
const popupRef = ref<InstanceType<typeof QuickTemplatePopup> | null>(null);

async function loadTemplates() {
  try {
    const res = await api.get<{ templates: TemplateItem[] }>('/automation/templates');
    templates.value = res.data.templates;
  } catch {
    // Non-critical — popup shows empty list on failure
  }
}

onMounted(() => { loadTemplates(); });

/** Detect `/` trigger: at start of input or immediately after a space */
function onInput(e: Event) {
  const value = (e.target as HTMLTextAreaElement).value;
  if (value === '/' || /\s\/$/.test(value)) {
    showTemplatePopup.value = true;
    templateQuery.value = '';
  } else if (showTemplatePopup.value) {
    const lastSlash = value.lastIndexOf('/');
    if (lastSlash === -1) {
      showTemplatePopup.value = false;
    } else {
      templateQuery.value = value.slice(lastSlash + 1);
    }
  }
}

/** Forward arrow/enter/escape keys to popup when open */
function onInputKeydown(e: KeyboardEvent) {
  if (!showTemplatePopup.value) return;
  if (['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(e.key)) {
    popupRef.value?.onKey(e);
  }
}

function onTemplateSelect(rendered: string) {
  const lastSlash = inputText.value.lastIndexOf('/');
  inputText.value = lastSlash >= 0 ? inputText.value.slice(0, lastSlash) + rendered : rendered;
  showTemplatePopup.value = false;
  templateQuery.value = '';
}
// --- End template quick-insert ---

function handleSend() {
  if (showTemplatePopup.value) { showTemplatePopup.value = false; return; }
  if (!inputText.value.trim()) return;
  emit('send', inputText.value);
  inputText.value = '';
}

function applySuggestion() { if (!props.aiSuggestion) return; inputText.value = props.aiSuggestion; }
function formatMessageTime(d: string) { return new Date(d).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }); }
function openFile(url: string) { window.open(url, '_blank'); }

/** Extract image URL from JSON content */
function getImageUrl(msg: Message): string | null {
  if (msg.contentType === 'image' && msg.content) {
    if (msg.content.startsWith('http')) return msg.content;
    try { const p = JSON.parse(msg.content); return p.href || p.thumb || p.hdUrl || null; } catch {}
  }
  if (msg.content?.startsWith('{')) {
    try {
      const p = JSON.parse(msg.content);
      const href = p.href || p.thumb || '';
      if (href && /\.(jpg|jpeg|png|webp|gif)/i.test(href)) return href;
      if (href && href.includes('zdn.vn') && !p.params?.includes('fileExt')) return href;
    } catch {}
  }
  return null;
}

/** Extract file info from JSON content (PDF, docs, etc.) */
function getFileInfo(msg: Message): { name: string; size: string; href: string } | null {
  if (!msg.content?.startsWith('{')) return null;
  try {
    const p = JSON.parse(msg.content);
    const params = typeof p.params === 'string' ? JSON.parse(p.params) : p.params;
    if (params?.fileExt || params?.fType === 1) {
      const bytes = parseInt(params.fileSize || '0');
      const size = bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
      return { name: p.title || `file.${params.fileExt || 'unknown'}`, size, href: p.href || '' };
    }
  } catch {}
  return null;
}

function parseDisplayContent(content: string | null): string {
  if (!content) return '';
  if (!content.startsWith('{')) return content;
  try {
    const p = JSON.parse(content);
    if (p.title && p.href) return `🔗 ${p.title}`;
    if (p.title) return p.title;
    if (p.href) return `🔗 ${p.description || p.href}`;
    return content;
  } catch { return content; }
}

function isReminderMessage(msg: Message): boolean {
  if (!msg.content) return false;
  try { const p = JSON.parse(msg.content); return p.action === 'msginfo.actionlist'; } catch { return false; }
}

function getReminderTitle(msg: Message): string {
  try { return JSON.parse(msg.content!).title || ''; } catch { return msg.content || ''; }
}

function getReminderTime(msg: Message): string | null {
  try {
    const p = JSON.parse(msg.content!);
    const params = typeof p.params === 'string' ? JSON.parse(p.params) : p.params;
    for (const h of (params?.highLightsV2 || [])) {
      if (h.ts > 1e12) return new Date(h.ts).toLocaleString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
  } catch {}
  return null;
}

/** Sync Zalo reminder to CRM appointments via API */
async function syncAppointment(msg: Message) {
  if (!props.conversation?.contact?.id) { syncSnack.value = { show: true, text: 'Không có thông tin khách hàng', color: 'error' }; return; }
  try {
    const p = JSON.parse(msg.content!);
    const params = typeof p.params === 'string' ? JSON.parse(p.params) : p.params;
    let appointmentDate: string | null = null;
    for (const h of (params?.highLightsV2 || [])) {
      if (h.ts > 1e12) { appointmentDate = new Date(h.ts).toISOString(); break; }
    }
    if (!appointmentDate) { syncSnack.value = { show: true, text: 'Không tìm thấy thời gian hẹn', color: 'warning' }; return; }
    await api.post('/appointments', {
      contactId: props.conversation.contact.id,
      appointmentDate,
      appointmentTime: new Date(appointmentDate).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
      type: 'tai_kham',
      notes: `[Zalo] ${p.title || ''}`,
    });
    syncSnack.value = { show: true, text: 'Đã đồng bộ lịch hẹn thành công!', color: 'success' };
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string } } };
    syncSnack.value = { show: true, text: e.response?.data?.error || 'Đồng bộ thất bại', color: 'error' };
  }
}

// ── History banner logic ──────────────────────────────────────────────────
// We distinguish three exhaustion sources so the copy is honest:
//   - Local DB: cursor pagination on the Message table (authoritative: when
//     the server returns hasMore=false there really is nothing older in DB)
//   - Zalo SDK group history: lacks a cursor — getGroupChatHistory only takes
//     `count` and may re-fetch the newest window. We only mark it exhausted
//     when the upstream explicitly reports more=false (Fix #5 round 2).
//   - User (1-1) threads: P5 R&D deferred, so we can't fetch history from
//     Zalo at all yet. Banner hides the "Lấy từ Zalo" path for these.
const canLoadMoreLocal = computed(() => {
  if (!props.conversation || props.messages.length === 0) return false;
  if (props.localHistoryExhausted) return false;
  const total = props.totalMessages ?? 0;
  return total > props.messages.length;
});

const canFetchZaloHistory = computed(() => {
  if (!props.conversation) return false;
  if (props.conversation.threadType !== 'group') return false;
  return props.conversation.historyExhausted !== true;
});

const historyFullyExhausted = computed(
  () => !canLoadMoreLocal.value && !canFetchZaloHistory.value,
);

const showHistoryBanner = computed(() => {
  if (!props.conversation) return false;
  // Don't render the banner while the initial page is still loading — the
  // exhaustion flags aren't meaningful until the first fetch settles.
  if (props.loading) return false;
  if (props.messages.length === 0) return false;
  return canLoadMoreLocal.value || canFetchZaloHistory.value || historyFullyExhausted.value;
});

const loadMoreButtonLabel = computed(() => {
  if (props.loadingMore) return 'Đang tải tin cũ…';
  if (props.fetchingHistory) return 'Đang gọi Zalo…';
  if (canLoadMoreLocal.value) return 'Tải thêm tin cũ (CRM)';
  if (canFetchZaloHistory.value) return 'Lấy thêm tin từ Zalo';
  return 'Không còn tin cũ';
});

const bannerHint = computed(() => {
  if (canLoadMoreLocal.value) return '';
  if (canFetchZaloHistory.value) {
    // When moreUpstream is explicitly false we know Zalo itself says no
    // more; we still allow a retry because `historyExhausted` gets set
    // conservatively (only on added=0 && more=false) per Fix #5.
    if (props.lastMoreUpstream === false) {
      return 'Zalo báo không còn lịch sử cũ hơn — nhấn để thử lại.';
    }
    return 'Zalo chỉ trả cửa sổ gần đây nhất; tin đã lưu sẽ được bỏ qua.';
  }
  if (props.conversation?.threadType === 'user') {
    return 'Hội thoại 1-1 chưa hỗ trợ lấy lịch sử cũ (đang R&D).';
  }
  return '';
});

function onLoadMoreClick() {
  if (props.loadingMore || props.fetchingHistory) return;
  if (canLoadMoreLocal.value) {
    captureScrollBeforePrepend();
    emit('load-more-local');
  } else if (canFetchZaloHistory.value) {
    captureScrollBeforePrepend();
    emit('fetch-history');
  }
}

// ── Scroll preservation for prepend vs append ────────────────────────────
// Without this, the simple `length` watcher would auto-scroll to bottom
// every time we prepend old messages, jarring the user back to the newest
// message and defeating the "Tải thêm" flow.
let prevFirstId: string | null = null;
let savedScrollHeight = 0;
function captureScrollBeforePrepend() {
  const el = messagesContainer.value;
  if (el) savedScrollHeight = el.scrollHeight;
}

watch(
  () => props.messages.map((m) => m.id),
  async (newIds, oldIds) => {
    await nextTick();
    const el = messagesContainer.value;
    if (!el) return;
    const currentFirstId = newIds[0] ?? null;
    const currentLen = newIds.length;
    const prevLen = oldIds?.length ?? 0;
    // Prepend = length grew AND the first id changed (old first still exists
    // inside newIds). Covers cursor load-more + fetch-history refetch cases.
    const prepended =
      prevFirstId !== null &&
      currentFirstId !== prevFirstId &&
      currentLen > prevLen &&
      newIds.includes(prevFirstId);
    if (prepended && savedScrollHeight > 0) {
      el.scrollTop += el.scrollHeight - savedScrollHeight;
    } else {
      // Append / initial load / conversation switch → scroll to newest
      el.scrollTop = el.scrollHeight;
    }
    prevFirstId = currentFirstId;
    savedScrollHeight = 0;
  },
  { flush: 'post' },
);
</script>

<style scoped>
.message-bubble { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1); }
.reminder-card { padding: 8px 12px; border-left: 3px solid #FFB74D; border-radius: 8px; background: rgba(255, 183, 77, 0.08); }
.file-card { display: flex; align-items: center; padding: 8px 12px; border-radius: 8px; background: rgba(0, 242, 255, 0.05); border: 1px solid rgba(0, 242, 255, 0.1); }
.chat-image { max-width: 100%; max-height: 300px; border-radius: 12px; cursor: pointer; transition: transform 0.2s; }
.chat-image:hover { transform: scale(1.02); }
.history-banner {
  padding: 8px 12px;
  margin-bottom: 12px;
  border-radius: 8px;
  background: rgba(0, 242, 255, 0.04);
  border: 1px dashed rgba(0, 242, 255, 0.15);
  text-align: center;
}
.history-banner-exhausted {
  background: transparent;
  border: none;
}
</style>
