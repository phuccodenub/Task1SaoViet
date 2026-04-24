<template>
  <v-list-item
    :class="{ 'bg-blue-lighten-5': highlight }"
    @click="$emit('toggle')"
    class="py-2"
  >
    <template #prepend>
      <v-checkbox-btn
        :model-value="selected"
        density="comfortable"
        @click.stop
        @update:model-value="$emit('toggle')"
      />
      <v-avatar size="36" color="grey-lighten-3" class="ml-2">
        <v-icon v-if="thread.threadType === 'group'" icon="mdi-account-group" />
        <v-img v-else-if="thread.avatar" :src="thread.avatar" />
        <v-icon v-else icon="mdi-account" />
      </v-avatar>
    </template>

    <v-list-item-title class="d-flex align-center">
      <span class="text-truncate font-weight-medium">
        {{ thread.displayName || '(không tên)' }}
      </span>
      <v-chip
        v-if="thread.threadType === 'group'"
        size="x-small"
        color="info"
        variant="tonal"
        class="ml-2"
      >Nhóm</v-chip>
      <v-chip
        v-if="thread.inAllowlist && !thread.allowlistEnabled"
        size="x-small"
        color="warning"
        variant="tonal"
        class="ml-1"
      >Tạm tắt</v-chip>
    </v-list-item-title>

    <v-list-item-subtitle class="d-flex align-center flex-wrap gap-1">
      <span v-if="thread.phone" class="text-caption text-grey-darken-1">
        {{ thread.phone }}
      </span>
      <v-divider v-if="thread.phone && thread.hasConversation" vertical class="mx-1" />
      <span v-if="thread.hasConversation" class="text-caption">
        <v-icon icon="mdi-message-text-outline" size="12" />
        Có hội thoại trong CRM
        <span
          v-if="thread.conversationVisibility && thread.conversationVisibility !== 'visible'"
          class="ml-1"
          :class="thread.conversationVisibility === 'pending' ? 'text-warning' : 'text-grey'"
        >
          ({{ visibilityLabel(thread.conversationVisibility) }})
        </span>
      </span>
      <span v-else class="text-caption text-grey">Chưa đồng bộ</span>
    </v-list-item-subtitle>

    <template #append>
      <span v-if="thread.lastMessageAt" class="text-caption text-grey">
        {{ formatDate(thread.lastMessageAt) }}
      </span>
    </template>
  </v-list-item>
</template>

<script setup lang="ts">
import type { AvailableThread, ConversationVisibility } from '@/api/zalo-allowlist';

defineProps<{
  thread: AvailableThread;
  selected: boolean;
  highlight?: boolean;
}>();

defineEmits<{ toggle: [] }>();

function visibilityLabel(v: ConversationVisibility): string {
  switch (v) {
    case 'pending': return 'Chờ duyệt';
    case 'hidden': return 'Đã ẩn';
    default: return 'Hiển thị';
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
  if (sameDay) {
    return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}
</script>
