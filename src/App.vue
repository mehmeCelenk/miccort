<script setup lang="ts">
import { computed, ref } from 'vue';
import VoiceRoom from './components/VoiceRoom.vue';

const roomId = ref('');
const serverUrl = ref('ws://localhost:8080/ws');
const displayName = ref('');
const activeRoomId = ref('');

const canJoin = computed(
  () =>
    roomId.value.trim().length > 0 &&
    serverUrl.value.trim().length > 0 &&
    displayName.value.trim().length > 0,
);

function createRoom() {
  roomId.value = crypto.randomUUID().slice(0, 8);
  joinRoom();
}

function joinRoom() {
  if (!canJoin.value) {
    return;
  }
  activeRoomId.value = roomId.value.trim();
}

function leaveRoom() {
  activeRoomId.value = '';
}
</script>

<template>
  <main class="app-shell">
    <section v-if="!activeRoomId" class="home">
      <aside class="brand-rail" aria-label="Workspace switcher">
        <div class="brand-mark">M</div>
        <div class="rail-dot active"></div>
        <div class="rail-dot"></div>
        <div class="rail-dot"></div>
      </aside>

      <div class="home-panel">
        <div class="home-copy">
          <p class="eyebrow">Mikcort</p>
          <h1>Voice rooms for close teams</h1>
          <p>Fast rooms, low-friction audio, and controls that stay where your hand expects them.</p>
        </div>

        <div class="join-stack">
          <label>
            Display name
            <input v-model="displayName" autocomplete="name" placeholder="Your Name" @keyup.enter="joinRoom" />
          </label>

          <label>
            Signaling server
            <input v-model="serverUrl" autocomplete="off" />
          </label>

          <label>
            Room ID
            <input v-model="roomId" autocomplete="off" placeholder="room-123" @keyup.enter="joinRoom" />
          </label>
        </div>

        <div class="actions">
          <button type="button" class="secondary" @click="createRoom">Create room</button>
          <button type="button" :disabled="!canJoin" @click="joinRoom">Join room</button>
        </div>
      </div>
    </section>

    <VoiceRoom
      v-else
      :room-id="activeRoomId"
      :server-url="serverUrl.trim()"
      :display-name="displayName.trim()"
      @left="leaveRoom"
    />
  </main>
</template>
