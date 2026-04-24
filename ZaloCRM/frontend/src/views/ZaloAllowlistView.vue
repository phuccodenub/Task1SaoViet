<template>
  <div class="pa-4">
    <!-- Header -->
    <div class="d-flex align-center mb-4">
      <v-btn icon variant="text" @click="$router.back()" title="Quay lại">
        <v-icon>mdi-arrow-left</v-icon>
      </v-btn>
      <div class="ml-2">
        <h1 class="text-h5 mb-0">Quản lý hội thoại Zalo</h1>
        <div class="text-caption text-grey">
          <span v-if="accountMeta">
            {{ accountMeta.displayName || accountMeta.zaloUid || accountMeta.id }}
          </span>
          <span v-else>Đang tải…</span>
        </div>
      </div>
    </div>

    <!-- Policy selector (owner/admin only) -->
    <v-card variant="outlined" class="mb-4">
      <v-card-text class="pa-4">
        <div class="text-subtitle-1 mb-2">Chính sách đồng bộ</div>
        <v-radio-group
          v-model="pendingPolicy"
          :disabled="!canChangePolicy || savingPolicy"
          hide-details
          density="compact"
        >
          <v-radio value="all" color="primary">
            <template #label>
              <span>
                <strong>Đồng bộ tất cả</strong>
                <span class="text-caption text-grey ml-2">— Mọi hội thoại mới đều hiện trong CRM (giống v2.1)</span>
              </span>
            </template>
          </v-radio>
          <v-radio value="allowlist" color="primary">
            <template #label>
              <span>
                <strong>Chỉ đồng bộ hội thoại được chọn</strong>
                <span class="text-caption text-grey ml-2">— Hội thoại khác sẽ nằm trong tab "Chờ duyệt"</span>
              </span>
            </template>
          </v-radio>
        </v-radio-group>

        <div v-if="!canChangePolicy" class="text-caption text-warning mt-2">
          <v-icon icon="mdi-lock" size="14" />
          Chỉ chủ tài khoản hoặc admin mới đổi được chính sách. Bạn vẫn có thể chọn hội thoại bên dưới.
        </div>

        <div v-if="pendingPolicy !== currentPolicy && canChangePolicy" class="mt-3 d-flex align-center">
          <v-alert
            density="compact"
            type="info"
            variant="tonal"
            class="flex-grow-1 mr-2"
          >
            Chính sách thay đổi từ
            <strong>{{ policyLabel(currentPolicy) }}</strong>
            sang
            <strong>{{ policyLabel(pendingPolicy) }}</strong>.
            Hội thoại đã có sẽ giữ nguyên, chỉ ảnh hưởng tin đến sau.
          </v-alert>
          <v-btn
            color="primary"
            :loading="savingPolicy"
            @click="savePolicy"
          >Lưu chính sách</v-btn>
        </div>
      </v-card-text>
    </v-card>

    <!-- Tabs -->
    <v-card variant="outlined">
      <v-tabs v-model="activeTab" color="primary" grow>
        <v-tab value="friends">
          <v-icon start icon="mdi-account" />
          Bạn bè
          <v-chip v-if="friendCount > 0" size="x-small" class="ml-2">{{ friendCount }}</v-chip>
        </v-tab>
        <v-tab value="groups">
          <v-icon start icon="mdi-account-group" />
          Nhóm
          <v-chip v-if="groupCount > 0" size="x-small" class="ml-2">{{ groupCount }}</v-chip>
        </v-tab>
        <v-tab value="pending">
          <v-icon start icon="mdi-timer-sand" />
          Chờ duyệt
          <v-chip
            v-if="pendingConvs.length > 0"
            size="x-small"
            color="warning"
            class="ml-2"
          >{{ pendingConvs.length }}</v-chip>
        </v-tab>
      </v-tabs>

      <v-divider />

      <!-- Toolbar for friends/groups tabs -->
      <div v-if="activeTab !== 'pending'" class="pa-3 d-flex align-center gap-2 flex-wrap">
        <v-text-field
          v-model="search"
          placeholder="Tìm theo tên, SĐT, UID…"
          prepend-inner-icon="mdi-magnify"
          density="compact"
          variant="solo-filled"
          hide-details
          style="max-width: 320px;"
          clearable
        />
        <v-btn size="small" variant="text" @click="selectAllVisible" prepend-icon="mdi-checkbox-marked-outline">
          Chọn tất cả ({{ visibleThreads.length }})
        </v-btn>
        <v-btn size="small" variant="text" @click="deselectAllVisible" prepend-icon="mdi-checkbox-blank-outline">
          Bỏ chọn
        </v-btn>
        <v-btn size="small" variant="text" @click="invertSelectionVisible" prepend-icon="mdi-checkbox-multiple-marked-circle-outline">
          Đảo chọn
        </v-btn>
        <v-spacer />
        <v-chip
          size="small"
          :color="hasPendingChanges ? 'warning' : 'default'"
          variant="tonal"
        >
          Đã chọn {{ selectedIds.size }} / {{ totalTickableThreads }}
        </v-chip>
        <v-btn
          color="primary"
          :disabled="!hasPendingChanges || saving"
          :loading="saving"
          @click="saveChanges"
        >
          Lưu thay đổi
        </v-btn>
      </div>

      <v-divider v-if="activeTab !== 'pending'" />

      <!-- Content -->
      <v-progress-linear v-if="loading" indeterminate color="primary" />

      <!-- Friends / Groups -->
      <v-list v-if="activeTab !== 'pending'" class="overflow-y-auto" style="max-height: calc(100vh - 420px);" density="comfortable">
        <AllowlistThreadRow
          v-for="thread in visibleThreads"
          :key="thread.externalThreadId"
          :thread="thread"
          :selected="selectedIds.has(thread.externalThreadId)"
          :highlight="selectedIds.has(thread.externalThreadId)"
          @toggle="toggleThread(thread.externalThreadId)"
        />
        <div v-if="!loading && visibleThreads.length === 0" class="text-center pa-8 text-grey">
          {{ activeTab === 'friends' ? 'Chưa tải được danh sách bạn bè' : 'Chưa tải được danh sách nhóm' }}
          <div class="text-caption mt-1">
            Đảm bảo tài khoản Zalo đang kết nối.
          </div>
        </div>
      </v-list>

      <!-- Pending -->
      <div v-else class="pa-3">
        <v-progress-linear v-if="loadingPending" indeterminate color="warning" />
        <div v-if="!loadingPending && pendingConvs.length === 0" class="text-center pa-6 text-grey">
          Không có hội thoại nào đang chờ duyệt.
        </div>
        <PendingConversationCard
          v-for="conv in pendingConvs"
          :key="conv.id"
          :conversation="conv"
          :approving="actions.approvingConv.value === conv.id"
          :rejecting="actions.rejectingConv.value === conv.id"
          @approve="handleApprove"
          @reject="handleReject"
        />
      </div>
    </v-card>

    <v-snackbar v-model="snackbar.show" :color="snackbar.color" timeout="3000">
      {{ snackbar.text }}
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import AllowlistThreadRow from '@/components/zalo/AllowlistThreadRow.vue';
import PendingConversationCard from '@/components/zalo/PendingConversationCard.vue';
import {
  getAllowlist,
  patchIngestPolicy,
  bulkAllowlist,
  getAvailableThreads,
  type AvailableThread,
  type IngestPolicy,
  type BulkAllowlistBody,
} from '@/api/zalo-allowlist';
import { useConversationActions } from '@/composables/useConversationActions';
import { api } from '@/api/index';
import type { Conversation } from '@/composables/use-chat';

const route = useRoute();
const authStore = useAuthStore();
const actions = useConversationActions();

const accountId = computed(() => String(route.params.id || ''));
const accountMeta = ref<{ id: string; displayName: string | null; zaloUid: string | null } | null>(null);

const activeTab = ref<'friends' | 'groups' | 'pending'>('friends');
const loading = ref(false);
const loadingPending = ref(false);
const saving = ref(false);
const savingPolicy = ref(false);
const search = ref('');

const currentPolicy = ref<IngestPolicy>('all');
const pendingPolicy = ref<IngestPolicy>('all');
const threads = ref<AvailableThread[]>([]);
const pendingConvs = ref<Conversation[]>([]);

// Baseline = threads that were enabled in the allowlist at load time.
// Diff against `selectedIds` at save to derive add/remove.
const initialEnabledIds = ref<Set<string>>(new Set());
const selectedIds = ref<Set<string>>(new Set());

const snackbar = reactive({ show: false, text: '', color: 'success' });

const canChangePolicy = computed(() => authStore.isAdmin);

const friendThreads = computed(() => threads.value.filter((t) => t.threadType === 'user'));
const groupThreads = computed(() => threads.value.filter((t) => t.threadType === 'group'));

const friendCount = computed(() => friendThreads.value.length);
const groupCount = computed(() => groupThreads.value.length);
const totalTickableThreads = computed(() => threads.value.length);

const visibleThreads = computed(() => {
  const pool = activeTab.value === 'friends' ? friendThreads.value : groupThreads.value;
  const q = search.value.trim().toLowerCase();
  if (!q) return pool;
  return pool.filter((t) => {
    const hay = [t.displayName, t.phone, t.externalThreadId].join(' ').toLowerCase();
    return hay.includes(q);
  });
});

const hasPendingChanges = computed(() => {
  // Quick size check first, then set diff
  if (selectedIds.value.size !== initialEnabledIds.value.size) return true;
  for (const id of selectedIds.value) {
    if (!initialEnabledIds.value.has(id)) return true;
  }
  return false;
});

function policyLabel(p: IngestPolicy): string {
  return p === 'all' ? 'Đồng bộ tất cả' : 'Chỉ đồng bộ hội thoại được chọn';
}

function showSnack(text: string, color: 'success' | 'error' | 'warning' = 'success') {
  snackbar.text = text;
  snackbar.color = color;
  snackbar.show = true;
}

function toggleThread(threadId: string) {
  const next = new Set(selectedIds.value);
  if (next.has(threadId)) next.delete(threadId);
  else next.add(threadId);
  selectedIds.value = next;
}

function selectAllVisible() {
  const next = new Set(selectedIds.value);
  visibleThreads.value.forEach((t) => next.add(t.externalThreadId));
  selectedIds.value = next;
}

function deselectAllVisible() {
  const next = new Set(selectedIds.value);
  visibleThreads.value.forEach((t) => next.delete(t.externalThreadId));
  selectedIds.value = next;
}

function invertSelectionVisible() {
  const next = new Set(selectedIds.value);
  visibleThreads.value.forEach((t) => {
    if (next.has(t.externalThreadId)) next.delete(t.externalThreadId);
    else next.add(t.externalThreadId);
  });
  selectedIds.value = next;
}

async function loadAccount() {
  try {
    const res = await api.get('/zalo-accounts');
    const list = Array.isArray(res.data) ? res.data : res.data.accounts || [];
    const match = list.find((a: any) => a.id === accountId.value);
    accountMeta.value = match
      ? { id: match.id, displayName: match.displayName, zaloUid: match.zaloUid }
      : null;
  } catch (err) {
    console.warn('[allowlist-view] load account meta failed:', err);
  }
}

async function loadData() {
  if (!accountId.value) return;
  loading.value = true;
  try {
    const [policyRes, threadsRes] = await Promise.all([
      getAllowlist(accountId.value),
      getAvailableThreads(accountId.value).catch((err) => {
        // available-threads needs a live connection; degrade gracefully
        console.warn('[allowlist-view] available-threads failed:', err?.response?.data || err);
        return { threads: [], cachedAt: 0 };
      }),
    ]);
    currentPolicy.value = policyRes.policy;
    pendingPolicy.value = policyRes.policy;
    threads.value = threadsRes.threads;

    // Initial tick = threads currently in allowlist with enabled=true
    const enabledSet = new Set<string>();
    for (const t of threadsRes.threads) {
      if (t.inAllowlist && t.allowlistEnabled) enabledSet.add(t.externalThreadId);
    }
    // Include allowlist rows that don't have a live thread entry (orphan rows)
    // so user can "uncheck" them too — build from policyRes.items.
    for (const item of policyRes.items) {
      if (item.enabled && !enabledSet.has(item.externalThreadId)) {
        enabledSet.add(item.externalThreadId);
      }
    }
    initialEnabledIds.value = enabledSet;
    selectedIds.value = new Set(enabledSet);
  } catch (err: any) {
    console.error('[allowlist-view] load failed:', err?.response?.data || err);
    showSnack('Không tải được danh sách allowlist', 'error');
  } finally {
    loading.value = false;
  }
}

async function loadPending() {
  if (!accountId.value) return;
  loadingPending.value = true;
  try {
    const res = await api.get('/conversations', {
      params: {
        accountId: accountId.value,
        visibility: 'pending',
        limit: 100,
      },
    });
    pendingConvs.value = res.data?.conversations || [];
  } catch (err: any) {
    console.error('[allowlist-view] load pending failed:', err?.response?.data || err);
  } finally {
    loadingPending.value = false;
  }
}

async function savePolicy() {
  if (pendingPolicy.value === currentPolicy.value) return;
  savingPolicy.value = true;
  try {
    const res = await patchIngestPolicy(accountId.value, pendingPolicy.value);
    currentPolicy.value = res.policy;
    pendingPolicy.value = res.policy;
    showSnack(`Đã đổi chính sách thành "${policyLabel(res.policy)}"`);
  } catch (err: any) {
    console.error('[allowlist-view] save policy failed:', err?.response?.data || err);
    showSnack(err?.response?.data?.error || 'Không đổi được chính sách', 'error');
    pendingPolicy.value = currentPolicy.value;
  } finally {
    savingPolicy.value = false;
  }
}

async function saveChanges() {
  const add: BulkAllowlistBody['add'] = [];
  const remove: string[] = [];

  for (const id of selectedIds.value) {
    if (!initialEnabledIds.value.has(id)) {
      const t = threads.value.find((x) => x.externalThreadId === id);
      if (t) add.push({ externalThreadId: id, threadType: t.threadType });
      // If we can't find the thread in the live list (unlikely), skip — can't
      // infer threadType safely.
    }
  }
  for (const id of initialEnabledIds.value) {
    if (!selectedIds.value.has(id)) remove.push(id);
  }

  if (add.length === 0 && remove.length === 0) return;

  saving.value = true;
  try {
    const res = await bulkAllowlist(accountId.value, { add, remove });
    const parts = [];
    if (res.added) parts.push(`+${res.added} mới`);
    if (res.removed) parts.push(`-${res.removed} bỏ`);
    if (res.hiddenConversations) parts.push(`${res.hiddenConversations} hội thoại đã ẩn`);
    showSnack(`Lưu thành công: ${parts.join(', ') || 'không có thay đổi'}`);
    await loadData();
    if (activeTab.value === 'pending') await loadPending();
  } catch (err: any) {
    console.error('[allowlist-view] save failed:', err?.response?.data || err);
    showSnack(err?.response?.data?.error || 'Không lưu được thay đổi', 'error');
  } finally {
    saving.value = false;
  }
}

async function handleApprove(convId: string) {
  const ok = await actions.approveConv(convId);
  if (ok) {
    pendingConvs.value = pendingConvs.value.filter((c) => c.id !== convId);
    showSnack('Đã duyệt hội thoại, các tin sau sẽ hiện bình thường');
    // Allowlist now has one more entry — refresh so the UI reflects it
    await loadData();
  } else {
    showSnack('Không duyệt được hội thoại', 'error');
  }
}

async function handleReject(convId: string) {
  const ok = await actions.rejectConv(convId);
  if (ok) {
    pendingConvs.value = pendingConvs.value.filter((c) => c.id !== convId);
    showSnack('Đã ẩn hội thoại');
  } else {
    showSnack('Không ẩn được hội thoại', 'error');
  }
}

watch(activeTab, (tab) => {
  if (tab === 'pending') void loadPending();
});

onMounted(async () => {
  await loadAccount();
  await Promise.all([loadData(), loadPending()]);
});
</script>

<style scoped>
.gap-2 { gap: 8px; }
.gap-1 { gap: 4px; }
</style>
