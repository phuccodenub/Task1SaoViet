<template>
  <v-dialog
    :model-value="modelValue"
    @update:model-value="onDialogToggle"
    max-width="720"
    persistent
    scrollable
  >
    <v-card>
      <v-card-title class="d-flex align-center">
        <v-icon icon="mdi-shield-check-outline" class="mr-2" color="primary" />
        <span>Cài đặt hội thoại Zalo</span>
        <v-spacer />
        <v-btn icon variant="text" size="small" @click="skip">
          <v-icon>mdi-close</v-icon>
        </v-btn>
      </v-card-title>

      <v-divider />

      <v-stepper v-model="step" alt-labels hide-actions>
        <v-stepper-header>
          <v-stepper-item :value="1" title="Chọn chính sách" />
          <v-divider />
          <v-stepper-item :value="2" title="Chọn hội thoại" :disabled="policy !== 'allowlist'" />
          <v-divider />
          <v-stepper-item :value="3" title="Xác nhận" />
        </v-stepper-header>
      </v-stepper>

      <v-card-text style="min-height: 320px; max-height: 60vh;" class="overflow-y-auto">
        <!-- Step 1: Welcome + policy -->
        <div v-if="step === 1">
          <div class="text-h6 mb-1">Đã kết nối: {{ accountName || 'Zalo' }}</div>
          <p class="text-body-2 text-grey-darken-1 mb-4">
            Bạn muốn CRM xử lý tin nhắn từ tài khoản này như thế nào?
          </p>

          <v-radio-group v-model="policy" hide-details>
            <v-radio value="allowlist" color="primary">
              <template #label>
                <div>
                  <strong>Chỉ đồng bộ hội thoại tôi chọn</strong>
                  <span class="v-chip v-chip--density-compact v-chip--size-x-small text-success ml-2">Khuyến nghị</span>
                  <div class="text-caption text-grey">
                    Tin nhắn từ gia đình, bạn bè không lên CRM. Tin từ hội thoại chưa chọn sẽ vào tab "Chờ duyệt" để bạn xem trước.
                  </div>
                </div>
              </template>
            </v-radio>

            <v-radio value="all" color="primary" class="mt-3">
              <template #label>
                <div>
                  <strong>Đồng bộ tất cả hội thoại</strong>
                  <div class="text-caption text-grey">
                    Giống v2.1 — mọi hội thoại mới đều vào CRM. Phù hợp nếu tài khoản Zalo này chỉ dùng cho công việc.
                  </div>
                </div>
              </template>
            </v-radio>
          </v-radio-group>
        </div>

        <!-- Step 2: Pick threads (only when policy = allowlist) -->
        <div v-else-if="step === 2">
          <div class="d-flex align-center mb-2">
            <div>
              <div class="text-subtitle-1">Chọn hội thoại muốn đồng bộ</div>
              <div class="text-caption text-grey">
                Mặc định tick những hội thoại đã có trong CRM. Bạn có thể đổi sau trong <em>Cài đặt → Quản lý hội thoại</em>.
              </div>
            </div>
            <v-spacer />
            <v-chip size="small" color="primary" variant="tonal">
              {{ selectedIds.size }} / {{ threads.length }}
            </v-chip>
          </div>

          <div class="d-flex gap-2 mb-2">
            <v-text-field
              v-model="search"
              placeholder="Tìm…"
              prepend-inner-icon="mdi-magnify"
              density="compact"
              variant="solo-filled"
              hide-details
              clearable
            />
            <v-btn size="small" variant="text" @click="selectAllVisible">Chọn tất</v-btn>
            <v-btn size="small" variant="text" @click="deselectAllVisible">Bỏ chọn</v-btn>
          </div>

          <v-progress-linear v-if="loadingThreads" indeterminate color="primary" />

          <v-alert
            v-if="!loadingThreads && threads.length === 0"
            type="info"
            variant="tonal"
            density="compact"
            class="my-2"
          >
            Chưa lấy được danh sách bạn bè / nhóm. Có thể tài khoản chưa sẵn sàng — bạn vẫn có thể chuyển bước kế tiếp và cấu hình sau.
          </v-alert>

          <v-list density="comfortable" style="max-height: 300px; overflow-y: auto;">
            <AllowlistThreadRow
              v-for="thread in visibleThreads"
              :key="thread.externalThreadId"
              :thread="thread"
              :selected="selectedIds.has(thread.externalThreadId)"
              @toggle="toggleThread(thread.externalThreadId)"
            />
          </v-list>
        </div>

        <!-- Step 3: Confirm -->
        <div v-else-if="step === 3">
          <div class="text-h6 mb-3">Xác nhận</div>

          <v-list density="comfortable">
            <v-list-item>
              <template #prepend><v-icon icon="mdi-shield-outline" /></template>
              <v-list-item-title>Chính sách</v-list-item-title>
              <v-list-item-subtitle>{{ policyLabel }}</v-list-item-subtitle>
            </v-list-item>

            <v-list-item v-if="policy === 'allowlist'">
              <template #prepend><v-icon icon="mdi-account" /></template>
              <v-list-item-title>Đã chọn</v-list-item-title>
              <v-list-item-subtitle>
                {{ selectedFriendCount }} cá nhân • {{ selectedGroupCount }} nhóm
              </v-list-item-subtitle>
            </v-list-item>
          </v-list>

          <v-alert
            v-if="policy === 'allowlist'"
            type="info"
            variant="tonal"
            density="compact"
            class="mt-3"
          >
            Tin nhắn từ hội thoại chưa chọn sẽ xuất hiện trong tab <strong>Chờ duyệt</strong> ở trang <em>Chat</em>. Hội thoại đã có trong CRM vẫn giữ nguyên cho đến khi bạn bỏ tick thủ công.
          </v-alert>

          <v-alert
            v-else
            type="info"
            variant="tonal"
            density="compact"
            class="mt-3"
          >
            Chính sách "Đồng bộ tất cả" giữ hành vi cũ — mọi hội thoại Zalo đều chảy vào CRM. Bạn có thể đổi sang allowlist bất kỳ lúc nào trong <em>Quản lý hội thoại</em>.
          </v-alert>
        </div>
      </v-card-text>

      <v-divider />

      <v-card-actions class="pa-3">
        <v-btn variant="text" @click="skip" :disabled="saving">
          Bỏ qua
        </v-btn>
        <v-spacer />
        <v-btn v-if="step > 1" variant="text" :disabled="saving" @click="goPrev">
          <v-icon start>mdi-arrow-left</v-icon>
          Quay lại
        </v-btn>
        <v-btn
          v-if="step < 3"
          color="primary"
          :disabled="!canGoNext"
          @click="goNext"
        >
          Tiếp tục
          <v-icon end>mdi-arrow-right</v-icon>
        </v-btn>
        <v-btn
          v-else
          color="primary"
          :loading="saving"
          @click="finish"
        >
          Hoàn tất
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import AllowlistThreadRow from '@/components/zalo/AllowlistThreadRow.vue';
import {
  getAvailableThreads,
  patchIngestPolicy,
  bulkAllowlist,
  type AvailableThread,
  type IngestPolicy,
} from '@/api/zalo-allowlist';

const props = defineProps<{
  modelValue: boolean;
  accountId: string;
  accountName?: string | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  completed: [result: { policy: IngestPolicy; addedCount: number }];
}>();

const step = ref(1);
const policy = ref<IngestPolicy>('allowlist');
const threads = ref<AvailableThread[]>([]);
const selectedIds = ref<Set<string>>(new Set());
const loadingThreads = ref(false);
const saving = ref(false);
const search = ref('');

const visibleThreads = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return threads.value;
  return threads.value.filter((t) => {
    const hay = [t.displayName, t.phone, t.externalThreadId].join(' ').toLowerCase();
    return hay.includes(q);
  });
});

const selectedFriendCount = computed(
  () => threads.value.filter((t) => t.threadType === 'user' && selectedIds.value.has(t.externalThreadId)).length,
);
const selectedGroupCount = computed(
  () => threads.value.filter((t) => t.threadType === 'group' && selectedIds.value.has(t.externalThreadId)).length,
);

const policyLabel = computed(() =>
  policy.value === 'allowlist' ? 'Chỉ đồng bộ hội thoại tôi chọn' : 'Đồng bộ tất cả',
);

const canGoNext = computed(() => {
  // Step 1: always allowed (policy is pre-selected)
  // Step 2: always allowed (empty selection = no allowlist entries yet — user
  //         can still finish; allowlist mode with zero entries means every
  //         new thread will land in pending, which is a valid explicit choice)
  return true;
});

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

async function loadThreads() {
  if (!props.accountId) return;
  loadingThreads.value = true;
  try {
    const res = await getAvailableThreads(props.accountId);
    threads.value = res.threads;
    // Default: tick threads that already have a visible conversation in the
    // CRM so the wizard preserves the data the user is already using.
    const presetSelected = new Set<string>();
    for (const t of res.threads) {
      if (t.hasConversation && t.conversationVisibility === 'visible') {
        presetSelected.add(t.externalThreadId);
      }
      if (t.inAllowlist && t.allowlistEnabled) {
        presetSelected.add(t.externalThreadId);
      }
    }
    selectedIds.value = presetSelected;
  } catch (err: any) {
    console.warn('[wizard] available-threads failed:', err?.response?.data || err);
    threads.value = [];
  } finally {
    loadingThreads.value = false;
  }
}

function goNext() {
  if (step.value === 1) {
    if (policy.value === 'allowlist') {
      step.value = 2;
      if (threads.value.length === 0 && !loadingThreads.value) void loadThreads();
    } else {
      // All-mode skips the picker
      step.value = 3;
    }
  } else if (step.value === 2) {
    step.value = 3;
  }
}

function goPrev() {
  if (step.value === 3 && policy.value === 'all') {
    step.value = 1;
  } else if (step.value > 1) {
    step.value -= 1;
  }
}

function skip() {
  // "Bỏ qua" is equivalent to "don't change anything" — mark as shown so we
  // don't pester the user again on this account.
  if (props.accountId) {
    localStorage.setItem(`zalocrm:wizard-shown:${props.accountId}`, '1');
  }
  emit('update:modelValue', false);
  resetState();
}

async function finish() {
  saving.value = true;
  let addedCount = 0;
  try {
    await patchIngestPolicy(props.accountId, policy.value);
    if (policy.value === 'allowlist' && selectedIds.value.size > 0) {
      const add = [] as Array<{ externalThreadId: string; threadType: 'user' | 'group' }>;
      for (const id of selectedIds.value) {
        const t = threads.value.find((x) => x.externalThreadId === id);
        if (t) add.push({ externalThreadId: id, threadType: t.threadType });
      }
      if (add.length > 0) {
        const res = await bulkAllowlist(props.accountId, { add });
        addedCount = res.added;
      }
    }
    localStorage.setItem(`zalocrm:wizard-shown:${props.accountId}`, '1');
    emit('completed', { policy: policy.value, addedCount });
    emit('update:modelValue', false);
    resetState();
  } catch (err: any) {
    console.error('[wizard] finish failed:', err?.response?.data || err);
    // Keep dialog open so user can retry
  } finally {
    saving.value = false;
  }
}

function resetState() {
  step.value = 1;
  policy.value = 'allowlist';
  threads.value = [];
  selectedIds.value = new Set();
  search.value = '';
}

function onDialogToggle(value: boolean) {
  if (!value && !saving.value) {
    emit('update:modelValue', false);
    resetState();
  }
}

watch(
  () => props.modelValue,
  (isOpen) => {
    if (isOpen) {
      resetState();
    }
  },
);
</script>

<style scoped>
.gap-2 { gap: 8px; }
</style>
