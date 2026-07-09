<script setup lang="ts">
import { Volume2 } from 'lucide-vue-next';

defineProps<{
  activeMemberVolumeUser: string | null;
  currentUserId: string;
  displayName: (userId: string) => string;
  initials: (userId: string) => string;
  isUserSharingScreen: (userId: string) => boolean;
  memberVolumes: Record<string, number>;
  screenShareBadgeLabel: (userId: string) => string;
  speakingUsers: Record<string, boolean>;
  users: string[];
  viewingScreenUser: string | null;
}>();

defineEmits<{
  setMemberVolume: [userId: string, event: Event];
  toggleMemberVolume: [userId: string];
  toggleScreenShareView: [userId: string];
}>();
</script>

<template>
  <div class="deck-members">
    <div class="panel-heading">
      <h2>Members</h2>
      <span>{{ users.length }}</span>
    </div>
    <ul class="user-list">
      <li
        v-for="userId in users"
        :key="userId"
        :class="{ speaking: speakingUsers[userId], selected: activeMemberVolumeUser === userId }"
        @click.stop="$emit('toggleMemberVolume', userId)"
      >
        <span class="avatar">{{ initials(userId) }}</span>
        <div class="member-info">
          <strong>{{ displayName(userId) }}</strong>
        </div>
        <button
          v-if="isUserSharingScreen(userId)"
          type="button"
          class="live-badge"
          :class="{ watching: viewingScreenUser === userId }"
          :disabled="userId === currentUserId"
          :title="userId === currentUserId ? 'You are sharing your screen' : viewingScreenUser === userId ? 'Stop watching stream' : 'Watch stream'"
          @click.stop="$emit('toggleScreenShareView', userId)"
        >
          {{ screenShareBadgeLabel(userId) }}
        </button>
        <button
          v-if="userId !== currentUserId"
          type="button"
          class="icon-button compact-button member-volume-button"
          :class="{ selected: activeMemberVolumeUser === userId }"
          data-tooltip="Volume"
          title="Member volume"
        >
          <Volume2 :size="16" />
        </button>
        <div v-if="activeMemberVolumeUser === userId" class="member-popover popover-panel" @click.stop>
          <strong>{{ displayName(userId) }}</strong>
          <label class="popover-slider">
            <span>
              <Volume2 :size="15" />
              Volume
            </span>
            <input
              type="range"
              min="0"
              max="100"
              :value="memberVolumes[userId] ?? 100"
              @input="$emit('setMemberVolume', userId, $event)"
            />
            <small>{{ memberVolumes[userId] ?? 100 }}%</small>
          </label>
        </div>
      </li>
    </ul>
  </div>
</template>
