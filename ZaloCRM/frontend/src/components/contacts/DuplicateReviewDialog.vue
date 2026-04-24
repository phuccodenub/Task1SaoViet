<template>
  <v-dialog v-model="show" max-width="800" scrollable>
    <v-card>
      <v-card-title class="d-flex align-center">
        <span>Khách hàng trùng lặp</span>
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" @click="show = false" />
      </v-card-title>

      <v-divider />

      <v-card-text>
        <v-progress-linear v-if="loadingDuplicates" indeterminate class="mb-4" />

        <div v-if="duplicateGroups.length === 0 && !loadingDuplicates" class="text-center text-grey py-8">
          Không có nhóm trùng lặp nào
        </div>

        <v-expansion-panels v-else variant="accordion">
          <v-expansion-panel
            v-for="group in duplicateGroups"
            :key="group.id"
          >
            <v-expansion-panel-title>
              <v-chip size="small" variant="tonal" class="mr-2">{{ matchTypeLabel(group.matchType) }}</v-chip>
              {{ group.contacts.map(c => c.fullName || 'N/A').join(' — ') }}
              <v-spacer />
              <v-chip size="x-small" variant="outlined">{{ group.contacts.length }} liên hệ</v-chip>
            </v-expansion-panel-title>

            <v-expansion-panel-text>
              <v-radio-group v-model="selectedPrimary[group.id]" class="mt-0">
                <v-table density="compact">
                  <thead>
                    <tr>
                      <th style="width: 50px;">Chính</th>
                      <th>Tên</th>
                      <th>SĐT</th>
                      <th>Zalo UID</th>
                      <th>Nguồn</th>
                      <th>Điểm</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="contact in group.contacts" :key="contact.id">
                      <td>
                        <v-radio :value="contact.id" density="compact" />
                      </td>
                      <td>{{ contact.fullName || '—' }}</td>
                      <td>{{ contact.phone || '—' }}</td>
                      <td class="text-caption">{{ contact.zaloUid || '—' }}</td>
                      <td>{{ contact.source || '—' }}</td>
                      <td>
                        <v-chip :color="scoreColor(contact.leadScore)" size="x-small" variant="tonal">
                          {{ contact.leadScore ?? 0 }}
                        </v-chip>
                      </td>
                    </tr>
                  </tbody>
                </v-table>
              </v-radio-group>

              <div class="d-flex justify-end mt-3">
                <v-btn
                  color="primary"
                  size="small"
                  :loading="merging"
                  :disabled="!selectedPrimary[group.id]"
                  @click="doMerge(group.id)"
                >
                  Gộp
                </v-btn>
              </div>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { watch, reactive } from 'vue';
import { useContactIntelligence } from '@/composables/use-contacts';

const show = defineModel<boolean>({ default: false });
const emit = defineEmits<{ merged: [] }>();

const { duplicateGroups, loadingDuplicates, merging, fetchDuplicateGroups, mergeDuplicateGroup } = useContactIntelligence();
const selectedPrimary = reactive<Record<string, string>>({});

watch(show, (open) => {
  if (open) fetchDuplicateGroups();
});

function matchTypeLabel(type: string) {
  const map: Record<string, string> = { phone: 'SĐT', zalo_uid: 'Zalo UID', name: 'Tên' };
  return map[type] ?? type;
}

function scoreColor(score: number) {
  if (score >= 70) return 'success';
  if (score >= 40) return 'orange';
  return 'error';
}

async function doMerge(groupId: string) {
  const primaryId = selectedPrimary[groupId];
  if (!primaryId) return;
  const ok = await mergeDuplicateGroup(groupId, primaryId);
  if (ok) {
    delete selectedPrimary[groupId];
    await fetchDuplicateGroups();
    emit('merged');
  }
}
</script>
