<script setup lang="ts">
import { computed, ref } from 'vue';
import VoiceRoom from './components/VoiceRoom.vue';

const roomId = ref('');
const serverUrl = ref('ws://localhost:8080/ws');
const activeRoomId = ref('');

const canJoin = computed(() => roomId.value.trim().length > 0 && serverUrl.value.trim().length > 0);

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
      <div class="home-panel">
        <div>
          <p class="eyebrow">Mikcort MVP</p>
          <h1>Desktop voice room</h1>
        </div>

        <label>
          Signaling server
          <input v-model="serverUrl" autocomplete="off" />
        </label>

        <label>
          Room ID
          <input v-model="roomId" autocomplete="off" placeholder="room-123" @keyup.enter="joinRoom" />
        </label>

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
      @left="leaveRoom"
    />
  </main>
</template>
