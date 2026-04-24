<template>
  <v-card variant="outlined" class="pending-card mb-2">
    <v-card-text class="d-flex align-center pa-3">
      <v-avatar size="40" color="grey-lighten-3">
        <v-icon v-if="conversation.threadType === 'group'" icon="mdi-account-group" />
        <v-img v-else-if="conversation.contact?.avatarUrl" :src="conversation.contact.avatarUrl" />
        <v-icon v-else icon="mdi-account" />
      </v-avatar>

      <div class="flex-grow-1 mx-3 overflow-hidden">
        <div class="d-flex align-center">
          <span class="text-subtitle-2 text-truncate font-weight-medium">
            {{ displayName }}
          </span>
          <v-chip
            v-if="conversation.threadType === 'group'"
            size="x-small"
            color="info"
            variant="tonal"
            class="ml-2"
          >Nhóm</v-chip>
        </div>
        <div class="text-caption text-grey text-truncate">
          {{ lastMessagePreview }}
        </div>
        <div class="text-caption text-grey-darken-1">
          {{ formatTime(conversation.lastMessageAt) }}
        </div>
      </div>

      <div class="d-flex flex-column gap-1">
        <v-btn
          size="small"
          color="success"
          variant="flat"
          :loading="approving"
          :disabled="busy"
          prepend-icon="mdi-check"
          @click="$emit('approve', conversation.id)"
        >Duyệt</v-btn>
        <v-btn
          size="small"
          color="error"
          variant="outlined"
          :loading="rejecting"
          :disabled="busy"
          prepend-icon="mdi-close"
          @click="$emit('reject', conversation.id)"
        >Bỏ qua</v-btn>
      </div>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Conversation } from '@/composables/use-chat';

const props = defineProps<{
  conversation: Conversation;
  approving?: boolean;
  rejecting?: boolean;
}>();

defineEmits<{
  approve: [conversationId: string];
  reject: [conversationId: string];
}>();

const busy = computed(() => !!props.approving || !!props.rejecting);

const displayName = computed(() => {
  const c = props.conversation.contact;
  if (!c) return '(chưa có liên hệ)';
  if (props.conversation.threadType === 'group') return c.fullName || 'Nhóm';
  return c.crmName || c.fullName || 'Unknown';
});

const lastMessagePreview = computed(() => {
  const msg = props.conversation.messages?.[0];
  if (!msg) return '(chưa có tin)';
  if (msg.isDeleted) return '(đã thu hồi)';
  const prefix = msg.senderType === 'self' ? 'Bạn: ' : '';
  if (msg.contentType !== 'text') return prefix + contentTypeLabel(msg.contentType);
  return prefix + (msg.content || '');
});

function contentTypeLabel(t: string): string {
  switch (t) {
    case 'image': return '📷 Hình ảnh';
    case 'sticker': return '🏷️ Sticker';
    case 'video': return '🎥 Video';
    case 'voice': return '🎤 Tin nhắn thoại';
    case 'file': return '📎 Tệp đính kèm';
    case 'gif': return 'GIF';
    default: return `[${t}]`;
  }
}

function formatTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'vừa xong';
  if (diffMin < 60) return `${diffMin} phút trước`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH} giờ trước`;
  return d.toLocaleDateString('vi-VN');
}
</script>

<style scoped>
.pending-card {
  transition: border-color 0.2s;
}
.pending-card:hover {
  border-color: rgb(var(--v-theme-primary));
}
</style>
