<script setup lang="ts">
import { Maximize2, Minimize2, Volume2, X } from 'lucide-vue-next';

defineProps<{
  activeScreenMenuUser: string | null;
  displayName: (userId: string) => string;
  fullscreenScreenUser: string | null;
  screenVolumes: Record<string, number>;
  viewedScreenUserId: string;
}>();

defineEmits<{
  closePopovers: [];
  openScreenMenu: [userId: string];
  setScreenVideoElement: [element: Element | null, userId: string];
  setScreenVolume: [userId: string, event: Event];
  stopViewing: [];
  toggleFullscreen: [userId: string];
}>();
</script>

<template>
  <section class="screen-share-grid" aria-label="Screen share">
    <article
      :key="viewedScreenUserId"
      :class="['screen-share-tile', { fullscreen: fullscreenScreenUser === viewedScreenUserId }]"
      @contextmenu.prevent.stop="$emit('openScreenMenu', viewedScreenUserId)"
      @click.stop="$emit('closePopovers')"
    >
      <div class="screen-share-header">
        <strong>{{ displayName(viewedScreenUserId) }} is sharing</strong>
        <button
          type="button"
          class="icon-button compact-button"
          :data-tooltip="fullscreenScreenUser === viewedScreenUserId ? 'Exit fullscreen' : 'Fullscreen'"
          :title="fullscreenScreenUser === viewedScreenUserId ? 'Exit fullscreen' : 'Fullscreen'"
          @click.stop="$emit('toggleFullscreen', viewedScreenUserId)"
        >
          <Minimize2 v-if="fullscreenScreenUser === viewedScreenUserId" :size="18" />
          <Maximize2 v-else :size="18" />
        </button>
        <button
          type="button"
          class="icon-button compact-button screen-stop-watch"
          data-tooltip="Stop watching"
          title="Stop watching"
          @click.stop="$emit('stopViewing')"
        >
          <X :size="18" />
        </button>
      </div>

      <div class="screen-video-wrap">
        <video
          :ref="(element) => $emit('setScreenVideoElement', element as Element | null, viewedScreenUserId)"
          :data-user-id="viewedScreenUserId"
          autoplay
          playsinline
          muted
          @dblclick.stop="$emit('toggleFullscreen', viewedScreenUserId)"
        ></video>

        <div v-if="activeScreenMenuUser === viewedScreenUserId" class="screen-menu popover-panel" @click.stop>
          <button type="button" class="menu-action" @click="$emit('toggleFullscreen', viewedScreenUserId)">
            <Minimize2 v-if="fullscreenScreenUser === viewedScreenUserId" :size="16" />
            <Maximize2 v-else :size="16" />
            {{ fullscreenScreenUser === viewedScreenUserId ? 'Exit fullscreen' : 'Fullscreen' }}
          </button>
          <label class="popover-slider">
            <span>
              <Volume2 :size="15" />
              Share audio
            </span>
            <input
              type="range"
              min="0"
              max="100"
              :value="screenVolumes[viewedScreenUserId] ?? 100"
              @input="$emit('setScreenVolume', viewedScreenUserId, $event)"
            />
            <small>{{ screenVolumes[viewedScreenUserId] ?? 100 }}%</small>
          </label>
        </div>
      </div>
    </article>
  </section>
</template>
