<script setup lang="ts">
import { Headphones, Mic, MicOff, MonitorUp, PhoneOff, Settings, VolumeX } from 'lucide-vue-next';

defineProps<{
  deafened: boolean;
  micStarted: boolean;
  micStarting: boolean;
  muted: boolean;
  screenShareMenuOpen: boolean;
  selectedScreenFps: number;
  settingsOpen: boolean;
  sharingScreen: boolean;
  userDisplayName: string;
  userInitials: string;
  voiceState: string;
}>();

defineEmits<{
  leave: [];
  startMicrophone: [];
  startScreenShare: [fps: number];
  toggleDeafen: [];
  toggleMute: [];
  toggleScreenShare: [];
  toggleSettings: [];
}>();
</script>

<template>
  <div class="voice-dock">
    <div class="dock-user">
      <span class="avatar">{{ userInitials }}</span>
      <div>
        <strong>{{ userDisplayName }}</strong>
        <small>{{ sharingScreen ? `Sharing screen - ${selectedScreenFps} FPS` : deafened ? 'Audio off' : voiceState }}</small>
      </div>
    </div>

    <div class="dock-actions" aria-label="Voice controls">
      <button
        type="button"
        class="icon-button"
        :class="{ active: micStarted && !muted, danger: muted }"
        :data-tooltip="micStarting ? 'Opening mic' : micStarted ? (muted ? 'Unmute mic' : 'Mute mic') : 'Start mic'"
        :title="micStarting ? 'Opening microphone' : micStarted ? (muted ? 'Unmute microphone' : 'Mute microphone') : 'Start microphone'"
        :disabled="micStarting"
        @click="micStarted ? $emit('toggleMute') : $emit('startMicrophone')"
      >
        <MicOff v-if="muted" :size="20" />
        <Mic v-else :size="20" />
      </button>

      <button
        type="button"
        class="icon-button"
        :class="{ danger: deafened }"
        :data-tooltip="deafened ? 'Enable audio' : 'Deafen'"
        :title="deafened ? 'Turn output on' : 'Deafen output'"
        @click="$emit('toggleDeafen')"
      >
        <VolumeX v-if="deafened" :size="20" />
        <Headphones v-else :size="20" />
      </button>

      <button
        type="button"
        class="icon-button"
        :class="{ selected: settingsOpen }"
        data-tooltip="Settings"
        title="Audio settings"
        @click="$emit('toggleSettings')"
      >
        <Settings :size="20" />
      </button>

      <div class="share-control">
        <button
          type="button"
          class="icon-button"
          :class="{ active: sharingScreen, selected: screenShareMenuOpen }"
          :data-tooltip="sharingScreen ? 'Stop sharing' : 'Share screen'"
          :title="sharingScreen ? 'Stop screen share' : 'Share screen'"
          @click.stop="$emit('toggleScreenShare')"
        >
          <MonitorUp :size="20" />
        </button>
        <div v-if="screenShareMenuOpen" class="share-menu popover-panel" @click.stop>
          <button type="button" class="menu-action" @click="$emit('startScreenShare', 30)">
            <MonitorUp :size="16" />
            30 FPS
          </button>
          <button type="button" class="menu-action" @click="$emit('startScreenShare', 60)">
            <MonitorUp :size="16" />
            60 FPS
          </button>
        </div>
      </div>

      <button type="button" class="icon-button leave-button" data-tooltip="Leave room" title="Leave room" @click="$emit('leave')">
        <PhoneOff :size="20" />
      </button>
    </div>
  </div>
</template>
