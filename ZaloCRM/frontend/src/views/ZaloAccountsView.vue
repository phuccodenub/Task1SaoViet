<template>
  <div>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h4">Tài khoản Zalo</h1>
      <v-spacer />
      <!-- Fix #25: Add account is owner/admin only on the backend; hide
           the trigger from members so they don't get a 403 toast. -->
      <v-btn v-if="authStore.isAdmin" color="primary" prepend-icon="mdi-plus" @click="showAddDialog = true">Thêm Zalo</v-btn>
    </div>

    <v-card>
      <v-data-table :headers="headers" :items="accounts" :loading="loading" no-data-text="Chưa có tài khoản Zalo nào">
        <template #item.status="{ item }">
          <v-chip :color="statusColor(item.liveStatus || item.status)" size="small" variant="flat">
            {{ statusText(item.liveStatus || item.status) }}
          </v-chip>
        </template>
        <template #item.actions="{ item }">
          <v-btn v-if="authStore.isAdmin" icon size="small" color="cyan" title="Phân quyền truy cập" @click="openAccess(item)">
            <v-icon>mdi-shield-account</v-icon>
          </v-btn>
          <!-- Allowlist management — requireZaloAccess('chat') on backend, so
               member with chat permission can use it; `canAdmin(item)` mirrors
               admin-level UI gate for all other destructive actions. -->
          <v-btn
            icon
            size="small"
            color="purple"
            title="Quản lý hội thoại (allowlist)"
            @click="$router.push(`/zalo-accounts/${item.id}/allowlist`)"
          >
            <v-icon>mdi-filter-variant</v-icon>
          </v-btn>
          <!-- Round 12 P2: wizard must be admin-only. AllowlistWizardDialog.finish
               always calls PATCH /ingest-policy which is owner/admin-only on
               the backend — without this gate, a chat-only member opening the
               wizard would hit a silent 403 on completion. Member-chat can
               still manage allowlist entries through the 🔽 "Quản lý hội thoại"
               button above (that endpoint accepts requireZaloAccess('chat')). -->
          <v-btn
            v-if="authStore.isAdmin"
            icon
            size="small"
            color="teal"
            title="Mở wizard cài đặt hội thoại"
            @click="openWizard(item)"
          >
            <v-icon>mdi-wizard-hat</v-icon>
          </v-btn>
          <!-- Fix #25: every action below requires admin permission on the
               specific account. requireZaloAccess('admin') on the backend
               accepts owner/admin role OR ownerUserId match (Fix #24).
               Members will see no buttons unless they own the account. -->
          <template v-if="canAdmin(item)">
            <v-btn icon size="small" color="success" @click="syncContacts(item.id)" title="Đồng bộ danh bạ Zalo" :loading="syncing === item.id">
              <v-icon>mdi-account-sync</v-icon>
            </v-btn>
            <v-btn v-if="item.liveStatus !== 'connected'" icon size="small" color="primary" @click="loginAccount(item.id)" title="Đăng nhập QR">
              <v-icon>mdi-qrcode</v-icon>
            </v-btn>
            <v-btn v-if="item.liveStatus === 'disconnected' && item.sessionData" icon size="small" color="info" @click="reconnectAccount(item.id)" title="Kết nối lại">
              <v-icon>mdi-refresh</v-icon>
            </v-btn>
            <v-btn icon size="small" color="error" @click="confirmDelete(item)" title="Xóa">
              <v-icon>mdi-delete</v-icon>
            </v-btn>
          </template>
        </template>
      </v-data-table>
    </v-card>

    <!-- Add account dialog -->
    <v-dialog v-model="showAddDialog" max-width="400">
      <v-card>
        <v-card-title>Thêm tài khoản Zalo</v-card-title>
        <v-card-text>
          <v-text-field v-model="newAccountName" label="Tên hiển thị (VD: Zalo Sale Hương)" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="showAddDialog = false">Hủy</v-btn>
          <v-btn color="primary" :loading="adding" @click="handleAddAccount">Thêm</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- QR Code dialog -->
    <v-dialog v-model="showQRDialog" max-width="400" persistent>
      <v-card class="text-center pa-4">
        <v-card-title>Quét QR để đăng nhập Zalo</v-card-title>
        <v-card-text>
          <div v-if="qrImage" class="mb-4">
            <img :src="'data:image/png;base64,' + qrImage" alt="QR Code" style="max-width: 280px;" />
          </div>
          <div v-else-if="qrScanned" class="mb-4">
            <v-icon icon="mdi-check-circle" size="64" color="success" />
            <p class="text-h6 mt-2">Đã quét! Xác nhận trên điện thoại...</p>
            <p v-if="scannedName" class="text-body-2">{{ scannedName }}</p>
          </div>
          <div v-else class="mb-4">
            <v-progress-circular indeterminate color="primary" size="64" />
            <p class="mt-2">Đang tạo QR code...</p>
          </div>
          <v-alert v-if="qrError" type="error" density="compact" class="mt-2">{{ qrError }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="cancelQR">Đóng</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete confirm dialog -->
    <v-dialog v-model="showDeleteDialog" max-width="400">
      <v-card>
        <v-card-title>Xác nhận xóa</v-card-title>
        <v-card-text>Bạn có chắc muốn xóa tài khoản "{{ deleteTarget?.displayName || deleteTarget?.id }}"?</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="showDeleteDialog = false">Hủy</v-btn>
          <v-btn color="error" :loading="deleting" @click="handleDeleteAccount">Xóa</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Access control dialog -->
    <ZaloAccessDialog
      v-model="showAccessDialog"
      :account-id="accessTarget?.id ?? ''"
      :account-name="accessTarget?.displayName ?? accessTarget?.id ?? ''"
    />

    <!-- Allowlist onboarding wizard — auto-opens for newly-connected accounts
         and is also reachable from the row action menu ("Mở wizard"). -->
    <AllowlistWizardDialog
      v-model="showWizard"
      :account-id="wizardTarget?.id ?? ''"
      :account-name="wizardTarget?.displayName ?? wizardTarget?.id ?? null"
      @completed="onWizardCompleted"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useZaloAccounts, type ZaloAccount } from '@/composables/use-zalo-accounts';
import { useAuthStore } from '@/stores/auth';
import ZaloAccessDialog from '@/components/settings/ZaloAccessDialog.vue';
import AllowlistWizardDialog from '@/components/zalo/AllowlistWizardDialog.vue';
import { api } from '@/api/index';

const {
  accounts, loading, adding, deleting,
  showQRDialog, qrImage, qrScanned, scannedName, qrError,
  statusColor, statusText,
  fetchAccounts, addAccount, loginAccount, reconnectAccount, deleteAccount,
  cancelQR, setupSocket, onAccountConnected,
} = useZaloAccounts();

const authStore = useAuthStore();

// Fix #25: gate admin-level account actions to mirror backend
// requireZaloAccess('admin'). Owner/admin role bypasses; member only
// passes when ownerUserId matches (legacy account fallback handled
// server-side too).
function canAdmin(item: any): boolean {
  if (authStore.isAdmin) return true;
  return item?.owner?.id === authStore.user?.id;
}

const showAddDialog = ref(false);
const syncing = ref<string | null>(null);
const showDeleteDialog = ref(false);
const showAccessDialog = ref(false);
const showWizard = ref(false);
const newAccountName = ref('');
const deleteTarget = ref<ZaloAccount | null>(null);
const accessTarget = ref<ZaloAccount | null>(null);
const wizardTarget = ref<ZaloAccount | null>(null);

const headers = [
  { title: 'Tên', key: 'displayName', sortable: true },
  { title: 'Zalo UID', key: 'zaloUid' },
  { title: 'SĐT', key: 'phone' },
  { title: 'Trạng thái', key: 'status', sortable: true },
  { title: 'Hành động', key: 'actions', sortable: false, align: 'end' as const },
];

async function syncContacts(accountId: string) {
  syncing.value = accountId;
  try {
    const res = await api.post(`/zalo-accounts/${accountId}/sync-contacts`);
    alert(`Đồng bộ thành công: ${res.data.created} mới, ${res.data.updated} cập nhật`);
  } catch (err: any) {
    alert('Đồng bộ thất bại: ' + (err.response?.data?.error || err.message));
  } finally {
    syncing.value = null;
  }
}

async function handleAddAccount() {
  const ok = await addAccount(newAccountName.value);
  if (ok) {
    showAddDialog.value = false;
    newAccountName.value = '';
  }
}

function confirmDelete(account: ZaloAccount) {
  deleteTarget.value = account;
  showDeleteDialog.value = true;
}

function openAccess(account: ZaloAccount) {
  accessTarget.value = account;
  showAccessDialog.value = true;
}

function openWizard(account: ZaloAccount) {
  wizardTarget.value = account;
  showWizard.value = true;
}

function onWizardCompleted() {
  // Refresh the list so any policy/allowlist changes reflect in status cells
  // right away. The wizard itself already persists state.
  fetchAccounts();
}

async function handleDeleteAccount() {
  if (!deleteTarget.value) return;
  const ok = await deleteAccount(deleteTarget.value);
  if (ok) {
    showDeleteDialog.value = false;
    deleteTarget.value = null;
  }
}

// Auto-open the onboarding wizard once per account. Registered at setup
// scope (not inside onMounted) so `onAccountConnected`'s internal
// `onUnmounted` teardown hooks up cleanly with this component's lifecycle
// regardless of when fetchAccounts/setupSocket run. Routes through the
// composable helper so we do NOT add a second `socket.on('zalo:connected')`
// in this view — Codex round 6 flagged how easily that drifts when
// backend rooms change scope.
//
// Round 12 P2: gate on authStore.isAdmin because the wizard's finish step
// patches ingestPolicy (owner/admin-only). Auto-opening it for members
// would end in a 403 no matter what they pick.
onAccountConnected((accountId) => {
  if (!authStore.isAdmin) return;
  const flagKey = `zalocrm:wizard-shown:${accountId}`;
  if (localStorage.getItem(flagKey)) return;
  // Wait briefly so fetchAccounts() (also triggered by the composable on
  // this event) has populated the row the wizard needs for account name.
  setTimeout(() => {
    const account = accounts.value.find((a) => a.id === accountId);
    if (!account) return;
    wizardTarget.value = account;
    showWizard.value = true;
  }, 300);
});

onMounted(() => {
  fetchAccounts();
  setupSocket();
});
</script>
