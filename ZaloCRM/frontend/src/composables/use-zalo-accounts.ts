/**
 * Composable for Zalo account management logic:
 * - CRUD operations via REST API
 * - Real-time QR login flow via Socket.IO
 */
import { ref, onUnmounted } from 'vue';
import { api } from '@/api/index';
import { io, Socket } from 'socket.io-client';

export interface ZaloAccount {
  id: string;
  displayName: string | null;
  zaloUid: string | null;
  status: string;
  liveStatus?: string;
  phone: string | null;
  sessionData: any;
  ownerUserId: string;
  createdAt: string;
}

export function useZaloAccounts() {
  const accounts = ref<ZaloAccount[]>([]);
  const loading = ref(false);
  const adding = ref(false);
  const deleting = ref(false);

  // QR dialog state
  const showQRDialog = ref(false);
  const qrImage = ref('');
  const qrScanned = ref(false);
  const scannedName = ref('');
  const qrError = ref('');
  const currentLoginAccountId = ref('');

  let socket: Socket | null = null;

  function statusColor(status: string) {
    switch (status) {
      case 'connected': return 'success';
      case 'qr_pending': case 'connecting': return 'warning';
      default: return 'error';
    }
  }

  function statusText(status: string) {
    switch (status) {
      case 'connected': return 'Đã kết nối';
      case 'qr_pending': return 'Chờ QR';
      case 'connecting': return 'Đang kết nối...';
      default: return 'Ngắt kết nối';
    }
  }

  // Track which account ids we've already subscribed to so we don't keep
  // re-emitting subscribe events on every fetchAccounts() refresh. Cleared
  // on disconnect via onUnmounted.
  const subscribedAccountIds = new Set<string>();

  // Callback fan-out for `zalo:connected` so views can react without adding
  // their own socket.on() handlers — avoids the round-6 pattern where
  // changing backend room scoping silently broke consumers that bound to
  // the raw event in multiple places. The composable owns the socket; the
  // caller just registers an interest via onAccountConnected().
  type ConnectedCallback = (accountId: string) => void;
  const connectedCallbacks: ConnectedCallback[] = [];

  /**
   * Register a callback invoked after every successful `zalo:connected`
   * socket event (both fresh QR logins and reconnects). The composable
   * dedups subscriptions and auto-cleans when the caller unmounts, so
   * callers never touch socket handlers directly.
   */
  function onAccountConnected(cb: ConnectedCallback) {
    connectedCallbacks.push(cb);
    onUnmounted(() => {
      const idx = connectedCallbacks.indexOf(cb);
      if (idx >= 0) connectedCallbacks.splice(idx, 1);
    });
  }

  function subscribeToAccount(accountId: string) {
    if (!socket || !accountId) return;
    if (subscribedAccountIds.has(accountId)) return;
    socket.emit('zalo:subscribe', { accountId });
    subscribedAccountIds.add(accountId);
  }

  /**
   * Centralized unsubscribe (Fix #27 + Fix #30): keeps the local cache in
   * sync with the socket room. NOT called from cancelQR anymore — the
   * account room now carries lifecycle events too, so it must stay
   * subscribed for the lifetime of the page. Reserved for explicit
   * tear-down (account deleted, user logout, reconnect cycle).
   */
  function unsubscribeFromAccount(accountId: string) {
    if (!socket || !accountId) return;
    if (!subscribedAccountIds.has(accountId)) return;
    socket.emit('zalo:unsubscribe', { accountId });
    subscribedAccountIds.delete(accountId);
  }

  /**
   * Subscribe to every account room the current user can access. After
   * Fix #23 (round 5) lifecycle events go to `account:<id>` rooms instead
   * of `org:<orgId>`, so without this bulk subscribe the accounts page
   * misses zalo:connected / disconnected / error / reconnect-failed for
   * accounts the user did not personally trigger via loginAccount() —
   * Codex called out this regression in round 6.
   */
  async function subscribeToAccessibleAccounts() {
    if (!socket) return;
    try {
      const res = await api.get('/zalo-accounts');
      const list: ZaloAccount[] = res.data || [];
      for (const acc of list) {
        if (acc?.id) subscribeToAccount(acc.id);
      }
    } catch (err) {
      console.warn('[zalo-accounts] failed to subscribe to account rooms:', err);
    }
  }

  async function fetchAccounts() {
    loading.value = true;
    try {
      const res = await api.get('/zalo-accounts');
      accounts.value = res.data;
      // Subscribe to any newly-visible accounts (e.g. created in another
      // tab / by another admin) so their lifecycle events land here too.
      for (const acc of accounts.value) {
        if (acc?.id) subscribeToAccount(acc.id);
      }
    } catch (err) {
      console.error('Failed to fetch accounts:', err);
    } finally {
      loading.value = false;
    }
  }

  async function addAccount(displayName: string) {
    adding.value = true;
    try {
      await api.post('/zalo-accounts', { displayName: displayName || undefined });
      await fetchAccounts();
      return true;
    } catch (err: any) {
      console.error('Failed to add account:', err);
      return false;
    } finally {
      adding.value = false;
    }
  }

  async function loginAccount(accountId: string) {
    currentLoginAccountId.value = accountId;
    qrImage.value = '';
    qrScanned.value = false;
    scannedName.value = '';
    qrError.value = '';
    showQRDialog.value = true;
    subscribeToAccount(accountId);
    try {
      await api.post(`/zalo-accounts/${accountId}/login`);
    } catch (err: any) {
      qrError.value = err.response?.data?.error || 'Không thể bắt đầu đăng nhập';
    }
  }

  async function reconnectAccount(accountId: string) {
    // Subscribe BEFORE triggering the reconnect so we don't miss the first
    // zalo:connected / zalo:reconnect-failed event that the pool emits.
    subscribeToAccount(accountId);
    try {
      await api.post(`/zalo-accounts/${accountId}/reconnect`);
      await fetchAccounts();
    } catch (err: any) {
      console.error('Reconnect failed:', err);
    }
  }

  async function deleteAccount(account: ZaloAccount) {
    deleting.value = true;
    try {
      await api.delete(`/zalo-accounts/${account.id}`);
      // Account is gone — release the room subscription so we don't keep
      // the cache entry around forever (Fix #30 reserved tear-down).
      unsubscribeFromAccount(account.id);
      await fetchAccounts();
      return true;
    } catch (err: any) {
      console.error('Delete failed:', err);
      return false;
    } finally {
      deleting.value = false;
    }
  }

  function cancelQR() {
    // Fix #30: do NOT unsubscribe from `account:<id>` here. After Fix #23
    // moved lifecycle events (zalo:connected/disconnected/error/
    // reconnect-failed) to the same account room used by QR delivery, the
    // page needs that subscription to stay alive — otherwise closing a QR
    // dialog silently drops the account's status updates until the next
    // fetchAccounts() refresh.
    //
    // The QR-related socket handlers below already gate their UI side
    // effects on `currentLoginAccountId` + `showQRDialog`, so leaving the
    // room subscribed costs nothing at the UI layer.
    showQRDialog.value = false;
    currentLoginAccountId.value = '';
  }

  function setupSocket() {
    // Pass JWT in handshake — backend verifies and auto-joins org room.
    // Account-specific lifecycle events live in `account:<id>` rooms after
    // Fix #23, so we additionally bulk-subscribe on connect (Fix #26).
    const token = localStorage.getItem('token') || '';
    socket = io({
      transports: ['websocket', 'polling'],
      auth: { token },
    });

    socket.on('connect', () => {
      // Re-subscribe whenever we (re)connect, since rooms are per-socket.
      subscribedAccountIds.clear();
      void subscribeToAccessibleAccounts();
    });

    socket.on('zalo:qr', (data: { accountId: string; qrImage: string }) => {
      if (data.accountId === currentLoginAccountId.value) qrImage.value = data.qrImage;
    });

    socket.on('zalo:scanned', (data: { accountId: string; displayName: string }) => {
      if (data.accountId === currentLoginAccountId.value) {
        qrImage.value = '';
        qrScanned.value = true;
        scannedName.value = data.displayName;
      }
    });

    socket.on('zalo:connected', (data: { accountId: string }) => {
      showQRDialog.value = false;
      fetchAccounts();
      for (const cb of connectedCallbacks) {
        try {
          cb(data.accountId);
        } catch (err) {
          console.warn('[zalo-accounts] onAccountConnected callback error:', err);
        }
      }
    });

    socket.on('zalo:disconnected', (_data: { accountId: string }) => { fetchAccounts(); });

    socket.on('zalo:error', (data: { accountId: string; error: string }) => {
      if (data.accountId === currentLoginAccountId.value) qrError.value = data.error;
      fetchAccounts();
    });

    socket.on('zalo:qr-expired', (data: { accountId: string }) => {
      if (data.accountId === currentLoginAccountId.value) {
        qrImage.value = '';
        qrError.value = 'QR đã hết hạn, đang tạo lại...';
      }
    });

    socket.on('zalo:reconnect-failed', (_data: { accountId: string }) => { fetchAccounts(); });
  }

  onUnmounted(() => {
    subscribedAccountIds.clear();
    socket?.disconnect();
  });

  return {
    accounts, loading, adding, deleting,
    showQRDialog, qrImage, qrScanned, scannedName, qrError,
    statusColor, statusText,
    fetchAccounts, addAccount, loginAccount, reconnectAccount, deleteAccount,
    cancelQR, setupSocket,
    onAccountConnected,
  };
}
