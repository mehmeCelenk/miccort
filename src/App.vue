<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Plus, RefreshCw, Users } from 'lucide-vue-next';
import VoiceRoom from './components/VoiceRoom.vue';

interface RoomSummary {
  id: string;
  users: string[];
}

const roomId = ref('');
const serverUrl = ref('ws://localhost:8080/ws');
const displayName = ref('');
const activeRoomId = ref('');
const updateMessage = ref('');
const updateTone = ref<'info' | 'success' | 'error'>('info');
const rooms = ref<RoomSummary[]>([]);
const roomsLoading = ref(false);
const roomsError = ref('');
let roomRefreshTimer: number | undefined;

const canJoin = computed(
  () =>
    roomId.value.trim().length > 0 &&
    serverUrl.value.trim().length > 0 &&
    displayName.value.trim().length > 0,
);
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
  if (!canJoin.value) {
    return;
  }
  activeRoomId.value = roomId.value.trim();
}

function joinExistingRoom(room: RoomSummary) {
  roomId.value = room.id;
  joinRoom();
}

function leaveRoom() {
  activeRoomId.value = '';
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
    const response = await fetch(endpoint);
    if (!response.ok) {
      throw new Error(`Room list failed with ${response.status}`);
    }
    const data = (await response.json()) as { rooms?: RoomSummary[] };
    rooms.value = (data.rooms ?? []).filter((room) => room.users.length > 0);
  } catch {
    rooms.value = [];
    roomsError.value = 'Rooms could not be loaded from this server.';
  } finally {
    roomsLoading.value = false;
  }
}

function buildRoomsEndpoint(value: string) {
  try {
    const url = new URL(value.trim());
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/rooms';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
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
            <input v-model="displayName" autocomplete="name" placeholder="Your Name" @keyup.enter="joinRoom" />
          </label>

          <label>
            Signaling server
            <input v-model="serverUrl" autocomplete="off" @change="loadRooms" />
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
              <button v-for="room in rooms" :key="room.id" type="button" class="room-row" :disabled="!canCreate" @click="joinExistingRoom(room)">
                <span class="room-row-mark">
                  <Users :size="17" />
                </span>
                <span class="room-row-body">
                  <strong>Room {{ room.id }}</strong>
                  <small>{{ room.users.join(', ') }}</small>
                </span>
                <span class="room-row-count">{{ room.users.length }}</span>
              </button>
            </template>
          </div>
        </div>

        <div class="actions">
          <button type="button" class="secondary action-with-icon" :disabled="!canCreate" @click="createRoom">
            <Plus :size="17" />
            Create room
          </button>
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
