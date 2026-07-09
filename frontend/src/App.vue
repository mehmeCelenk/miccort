<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Lock, Plus, RefreshCw, Users } from 'lucide-vue-next';
import VoiceRoom from './components/VoiceRoom.vue';
import { usePersistentString } from './composables/usePersistentStorage';
import { buildRoomsEndpoint, fetchLiveRooms } from './features/rooms/api';
import type { RoomSummary } from './features/rooms/types';

const roomId = ref('');
const roomPassword = ref('');
const serverUrl = usePersistentString('mikcort:server-url', 'ws://localhost:8080/ws', { trim: true });
const displayName = usePersistentString('mikcort:display-name', '', { trim: true });
const activeRoomId = ref('');
const activeRoomPassword = ref('');
const updateMessage = ref('');
const updateTone = ref<'info' | 'success' | 'error'>('info');
const rooms = ref<RoomSummary[]>([]);
const roomsLoading = ref(false);
const roomsError = ref('');
const roomJoinHint = ref('');
let roomRefreshTimer: number | undefined;

const canCreate = computed(() => serverUrl.value.trim().length > 0 && displayName.value.trim().length > 0);
const roomsEndpoint = computed(() => buildRoomsEndpoint(serverUrl.value));

onMounted(() => {
  window.addEventListener('mikcort:update-status', handleUpdateStatus);
  void loadRooms();
  roomRefreshTimer = window.setInterval(() => {
    void loadRooms();
  }, 5000);
});

onBeforeUnmount(() => {
  window.removeEventListener('mikcort:update-status', handleUpdateStatus);
  if (roomRefreshTimer) {
    window.clearInterval(roomRefreshTimer);
  }
});

function createRoom() {
  roomId.value = crypto.randomUUID().slice(0, 8);
  joinRoom();
}

function joinRoom() {
  if (!canCreate.value || !roomId.value.trim()) {
    return;
  }
  roomJoinHint.value = '';
  activeRoomId.value = roomId.value.trim();
  activeRoomPassword.value = roomPassword.value.trim();
}

function joinExistingRoom(room: RoomSummary) {
  roomId.value = room.id;
  if (room.locked && !roomPassword.value.trim()) {
    roomJoinHint.value = 'Password required for private room.';
    return;
  }
  joinRoom();
}

function leaveRoom() {
  activeRoomId.value = '';
  activeRoomPassword.value = '';
  void loadRooms();
}

function handleJoinRejected(message: string) {
  activeRoomId.value = '';
  activeRoomPassword.value = '';
  roomJoinHint.value = message;
  void loadRooms();
}

function handleUpdateStatus(event: Event) {
  const detail = (event as CustomEvent<{ status: string; message: string }>).detail;
  updateMessage.value = detail.message;
  updateTone.value = detail.status === 'error' ? 'error' : detail.status === 'installed' ? 'success' : 'info';

  if (detail.status === 'not-available') {
    window.setTimeout(() => {
      if (updateMessage.value === detail.message) {
        updateMessage.value = '';
      }
    }, 5000);
  }
}

async function loadRooms() {
  const endpoint = roomsEndpoint.value;
  if (!endpoint) {
    rooms.value = [];
    roomsError.value = 'Server address is not valid.';
    return;
  }

  roomsLoading.value = true;
  roomsError.value = '';
  try {
    rooms.value = await fetchLiveRooms(endpoint);
  } catch {
    rooms.value = [];
    roomsError.value = 'Rooms could not be loaded from this server.';
  } finally {
    roomsLoading.value = false;
  }
}
</script>

<template>
  <main class="app-shell">
    <div v-if="updateMessage" :class="['update-toast', updateTone]">
      {{ updateMessage }}
    </div>

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
            <input v-model="displayName" autocomplete="name" placeholder="Your Name" />
          </label>

          <label>
            Signaling server
            <input v-model="serverUrl" autocomplete="off" @change="loadRooms" />
          </label>

          <label>
            Room password
            <input
              v-model="roomPassword"
              autocomplete="off"
              placeholder="Optional for private rooms"
              type="password"
              @input="roomJoinHint = ''"
              @keyup.enter="joinRoom"
            />
            <small v-if="roomJoinHint" class="field-error">{{ roomJoinHint }}</small>
          </label>

          <div class="room-browser">
            <div class="room-browser-heading">
              <div>
                <span>Available rooms</span>
                <small>{{ rooms.length ? `${rooms.length} live` : 'No live rooms' }}</small>
              </div>
              <button type="button" class="icon-button compact-button" data-tooltip="Refresh rooms" title="Refresh rooms" @click="loadRooms">
                <RefreshCw :size="16" />
              </button>
            </div>

            <div v-if="roomsLoading" class="room-empty">Loading rooms...</div>
            <div v-else-if="roomsError" class="room-empty error-lite">{{ roomsError }}</div>
            <div v-else-if="!rooms.length" class="room-empty">Create a room to start the first conversation.</div>
            <template v-else>
              <button
                v-for="room in rooms"
                :key="room.id"
                type="button"
                class="room-row"
                :class="{ locked: room.locked }"
                :disabled="!canCreate"
                @click="joinExistingRoom(room)"
              >
                <span class="room-row-mark">
                  <Lock v-if="room.locked" :size="17" />
                  <Users v-else :size="17" />
                </span>
                <span class="room-row-body">
                  <strong>Room {{ room.id }}</strong>
                  <small>{{ room.locked ? 'Private room' : room.users.join(', ') }}</small>
                </span>
                <span :class="['room-row-count', { private: room.locked }]">
                  <Lock v-if="room.locked" :size="14" />
                  <template v-else>{{ room.users.length }}</template>
                </span>
              </button>
            </template>
          </div>
        </div>

        <div class="actions">
          <button type="button" class="secondary action-with-icon" :disabled="!canCreate" @click="createRoom">
            <Plus :size="17" />
            Create new room
          </button>
        </div>
      </div>
    </section>

    <VoiceRoom
      v-else
      :room-id="activeRoomId"
      :server-url="serverUrl.trim()"
      :display-name="displayName.trim()"
      :room-password="activeRoomPassword"
      @join-rejected="handleJoinRejected"
      @left="leaveRoom"
    />
  </main>
</template>
