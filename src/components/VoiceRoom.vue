<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { Headphones, MonitorUp, Mic, MicOff, PhoneOff, Settings, VolumeX, X } from 'lucide-vue-next';

type SignalType =
  | 'join-room'
  | 'user-joined'
  | 'user-left'
  | 'offer'
  | 'answer'
  | 'ice-candidate'
  | 'room-users'
  | 'ping'
  | 'pong'
  | 'error';

interface SignalMessage {
  type: SignalType;
  roomId?: string;
  userId?: string;
  targetUserId?: string;
  payload?: unknown;
}

interface RoomUsersPayload {
  users: Array<string | UserSummary>;
  self?: UserSummary;
}

interface ErrorPayload {
  message: string;
}

interface UserSummary {
  id: string;
  displayName?: string;
}

const props = defineProps<{
  roomId: string;
  serverUrl: string;
  displayName: string;
}>();

const emit = defineEmits<{
  left: [];
}>();

const currentUserId = ref<string>(crypto.randomUUID());
const users = ref<string[]>([]);
const status = ref('Connecting to signaling server...');
const error = ref('');
const micStarted = ref(false);
const muted = ref(false);
const deafened = ref(false);
const mutedBeforeDeafen = ref<boolean | null>(null);
const settingsOpen = ref(false);
const sharingScreen = ref(false);
const wsOpen = ref(false);
const remoteAudio = ref<HTMLDivElement | null>(null);
const screenShareHost = ref<HTMLDivElement | null>(null);
const inputDevices = ref<MediaDeviceInfo[]>([]);
const outputDevices = ref<MediaDeviceInfo[]>([]);
const selectedInputId = ref('');
const selectedOutputId = ref('');
const inputGain = ref(100);
const outputVolume = ref(100);
const noiseSuppression = ref(true);
const echoCancellation = ref(true);
const autoGainControl = ref(true);
const peerStates = reactive<Record<string, string>>({});
const userNames = reactive<Record<string, string>>({});

let socket: WebSocket | null = null;
let rawLocalStream: MediaStream | null = null;
let localStream: MediaStream | null = null;
let screenStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let micGainNode: GainNode | null = null;
let reconnectTimer: number | undefined;
let heartbeatTimer: number | undefined;
let intentionallyClosed = false;
const peers = new Map<string, RTCPeerConnection>();
const queuedCandidates = new Map<string, RTCIceCandidateInit[]>();

const otherUsers = computed(() => users.value.filter((userId) => userId !== currentUserId.value));
const roomTag = computed(() => props.roomId.slice(0, 2).toUpperCase());
const connectionLabel = computed(() => (wsOpen.value ? 'Connected' : 'Offline'));
const voiceState = computed(() => {
  if (!micStarted.value) {
    return 'Ready';
  }
  return muted.value ? 'Muted' : 'Live';
});

onMounted(() => {
  connect();
  void loadDevices();
  navigator.mediaDevices?.addEventListener('devicechange', loadDevices);
});
onBeforeUnmount(cleanup);

function connect() {
  clearReconnectTimer();
  clearHeartbeat();
  intentionallyClosed = false;
  socket = new WebSocket(props.serverUrl);

  socket.addEventListener('open', () => {
    wsOpen.value = true;
    error.value = '';
    status.value = 'Joined room. Start your microphone when ready.';
    startHeartbeat();
    send({
      type: 'join-room',
      roomId: props.roomId,
      userId: currentUserId.value,
      payload: {
        displayName: props.displayName,
      },
    });
  });

  socket.addEventListener('message', (event: MessageEvent<string>) => {
    try {
      void handleSignal(JSON.parse(event.data) as SignalMessage);
    } catch {
      error.value = 'Received invalid signaling message.';
    }
  });

  socket.addEventListener('close', () => {
    clearHeartbeat();
    wsOpen.value = false;
    status.value = 'Disconnected from signaling server. Reconnecting...';
    if (!intentionallyClosed) {
      scheduleReconnect();
    }
  });

  socket.addEventListener('error', () => {
    error.value = 'Could not connect to the signaling server.';
  });
}

function scheduleReconnect() {
  clearReconnectTimer();
  reconnectTimer = window.setTimeout(() => {
    connect();
  }, 1500);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
}

function startHeartbeat() {
  clearHeartbeat();
  heartbeatTimer = window.setInterval(() => {
    send({ type: 'ping', roomId: props.roomId, userId: currentUserId.value });
  }, 20_000);
}

function clearHeartbeat() {
  if (heartbeatTimer) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}

async function startMicrophone() {
  try {
    error.value = '';
    await openMicrophone();
    muted.value = false;
    micStarted.value = true;
    status.value = 'Microphone is on.';

    for (const userId of otherUsers.value) {
      await ensurePeer(userId, true);
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Microphone permission failed.';
  }
}

async function loadDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return;
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  inputDevices.value = devices.filter((device) => device.kind === 'audioinput');
  outputDevices.value = devices.filter((device) => device.kind === 'audiooutput');

  if (!selectedInputId.value && inputDevices.value[0]) {
    selectedInputId.value = inputDevices.value[0].deviceId;
  }
  if (!selectedOutputId.value && outputDevices.value[0]) {
    selectedOutputId.value = outputDevices.value[0].deviceId;
  }
}

async function applyAudioSettings() {
  updateMicGain();
  updateRemoteAudioSettings();
  if (micStarted.value) {
    await restartMicrophone();
  }
}

async function restartMicrophone() {
  const wasMuted = muted.value;
  stopLocalAudio();
  await openMicrophone();
  muted.value = wasMuted;
  setLocalTracksEnabled(!wasMuted);

  for (const peer of peers.values()) {
    const nextTrack = localStream?.getAudioTracks()[0] ?? null;
    for (const sender of peer.getSenders()) {
      if (sender.track?.kind === 'audio') {
        await sender.replaceTrack(nextTrack);
      }
    }
  }
}

async function openMicrophone() {
  rawLocalStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: selectedInputId.value ? { exact: selectedInputId.value } : undefined,
      noiseSuppression: noiseSuppression.value,
      echoCancellation: echoCancellation.value,
      autoGainControl: autoGainControl.value,
    },
  });
  localStream = buildProcessedMicrophoneStream(rawLocalStream);
  updateMicGain();
  await loadDevices();
}

function buildProcessedMicrophoneStream(stream: MediaStream) {
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  micGainNode = audioContext.createGain();
  const destination = audioContext.createMediaStreamDestination();
  source.connect(micGainNode);
  micGainNode.connect(destination);
  return destination.stream;
}

function updateMicGain() {
  if (micGainNode) {
    micGainNode.gain.value = inputGain.value / 100;
  }
}

function updateRemoteAudioSettings() {
  const volume = deafened.value ? 0 : outputVolume.value / 100;
  remoteAudio.value?.querySelectorAll('audio').forEach((element) => {
    const audio = element as HTMLAudioElement & {
      setSinkId?: (sinkId: string) => Promise<void>;
    };
    audio.volume = volume;
    if (selectedOutputId.value && audio.setSinkId) {
      void audio.setSinkId(selectedOutputId.value).catch(() => {
        error.value = 'Selected output device is not available.';
      });
    }
  });
}

function toggleMute() {
  if (!localStream) {
    return;
  }
  if (muted.value && deafened.value) {
    deafened.value = false;
    mutedBeforeDeafen.value = null;
  }
  muted.value = !muted.value;
  setLocalTracksEnabled(!muted.value);
  updateRemoteAudioSettings();
}

function toggleDeafen() {
  const nextDeafened = !deafened.value;
  deafened.value = nextDeafened;
  if (nextDeafened) {
    mutedBeforeDeafen.value = muted.value;
    if (localStream && !muted.value) {
      muted.value = true;
      setLocalTracksEnabled(false);
    }
  } else {
    const shouldRestoreMic = mutedBeforeDeafen.value === false;
    mutedBeforeDeafen.value = null;
    if (localStream && shouldRestoreMic) {
      muted.value = false;
      setLocalTracksEnabled(true);
    }
  }
  updateRemoteAudioSettings();
}

function leave() {
  cleanup();
  emit('left');
}

async function handleSignal(message: SignalMessage) {
  switch (message.type) {
    case 'room-users': {
      const payload = message.payload as RoomUsersPayload;
      if (message.userId) {
        currentUserId.value = message.userId;
      }
      userNames[currentUserId.value] = payload.self?.displayName || props.displayName;
      const existingUsers = (payload.users ?? []).map(registerUser);
      users.value = unique([currentUserId.value, ...existingUsers]);
      break;
    }
    case 'user-joined':
      if (message.userId && message.userId !== currentUserId.value) {
        registerUser((message.payload as UserSummary | undefined) ?? message.userId);
        users.value = unique([...users.value, message.userId]);
        if (localStream) {
          await ensurePeer(message.userId, true);
        }
      }
      break;
    case 'user-left':
      if (message.userId) {
        users.value = users.value.filter((userId) => userId !== message.userId);
        closePeer(message.userId);
      }
      break;
    case 'offer':
      if (message.userId) {
        await receiveOffer(message.userId, message.payload as RTCSessionDescriptionInit);
      }
      break;
    case 'answer':
      if (message.userId) {
        const peer = peers.get(message.userId);
        if (peer) {
          await peer.setRemoteDescription(message.payload as RTCSessionDescriptionInit);
          await flushQueuedCandidates(message.userId, peer);
        }
      }
      break;
    case 'ice-candidate':
      if (message.userId) {
        await receiveCandidate(message.userId, message.payload as RTCIceCandidateInit);
      }
      break;
    case 'pong':
      break;
    case 'error': {
      const payload = message.payload as ErrorPayload;
      error.value = payload.message ?? 'Signaling error.';
      break;
    }
  }
}

async function ensurePeer(userId: string, makeOffer: boolean) {
  let peer = peers.get(userId);
  if (!peer) {
    peer = createPeer(userId);
    peers.set(userId, peer);
  }

  if (localStream) {
    for (const track of localStream.getAudioTracks()) {
      if (!peer.getSenders().some((sender) => sender.track === track)) {
        peer.addTrack(track, localStream);
      }
    }
  }

  if (screenStream) {
    for (const track of screenStream.getVideoTracks()) {
      if (!peer.getSenders().some((sender) => sender.track === track)) {
        peer.addTrack(track, screenStream);
      }
    }
  }

  if (makeOffer) {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    send({
      type: 'offer',
      roomId: props.roomId,
      userId: currentUserId.value,
      targetUserId: userId,
      payload: offer,
    });
  }

  return peer;
}

function createPeer(userId: string) {
  const peer = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  peerStates[userId] = 'new';

  peer.onicecandidate = (event) => {
    if (event.candidate) {
      send({
        type: 'ice-candidate',
        roomId: props.roomId,
        userId: currentUserId.value,
        targetUserId: userId,
        payload: event.candidate.toJSON(),
      });
    }
  };

  peer.onconnectionstatechange = () => {
    peerStates[userId] = peer.connectionState;
  };

  peer.ontrack = (event) => {
    if (event.track.kind === 'audio') {
      attachRemoteAudio(userId, event.streams[0]);
    } else if (event.track.kind === 'video') {
      attachRemoteScreen(userId, event.streams[0]);
    }
  };

  return peer;
}

async function receiveOffer(userId: string, offer: RTCSessionDescriptionInit) {
  const peer = await ensurePeer(userId, false);
  await peer.setRemoteDescription(offer);
  await flushQueuedCandidates(userId, peer);

  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  send({
    type: 'answer',
    roomId: props.roomId,
    userId: currentUserId.value,
    targetUserId: userId,
    payload: answer,
  });
}

async function receiveCandidate(userId: string, candidate: RTCIceCandidateInit) {
  const peer = peers.get(userId);
  if (!peer || !peer.remoteDescription) {
    const queued = queuedCandidates.get(userId) ?? [];
    queued.push(candidate);
    queuedCandidates.set(userId, queued);
    return;
  }
  await peer.addIceCandidate(candidate);
}

async function flushQueuedCandidates(userId: string, peer: RTCPeerConnection) {
  const queued = queuedCandidates.get(userId) ?? [];
  queuedCandidates.delete(userId);
  for (const candidate of queued) {
    await peer.addIceCandidate(candidate);
  }
}

function attachRemoteAudio(userId: string, stream: MediaStream) {
  const host = remoteAudio.value;
  if (!host || host.querySelector(`[data-user-id="${userId}"]`)) {
    return;
  }

  const audio = document.createElement('audio');
  audio.dataset.userId = userId;
  audio.autoplay = true;
  audio.volume = outputVolume.value / 100;
  audio.srcObject = stream;
  host.appendChild(audio);
  updateRemoteAudioSettings();
}

async function toggleScreenShare() {
  if (sharingScreen.value) {
    await stopScreenShare();
  } else {
    await startScreenShare();
  }
}

async function startScreenShare() {
  try {
    error.value = '';
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    sharingScreen.value = true;

    const [track] = screenStream.getVideoTracks();
    track.addEventListener('ended', () => {
      void stopScreenShare();
    });

    for (const userId of otherUsers.value) {
      await ensurePeer(userId, true);
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Screen share could not start.';
  }
}

async function stopScreenShare() {
  const stoppedStream = screenStream;
  screenStream = null;
  sharingScreen.value = false;
  stoppedStream?.getTracks().forEach((track) => track.stop());

  for (const peer of peers.values()) {
    for (const sender of peer.getSenders()) {
      if (sender.track?.kind === 'video') {
        await sender.replaceTrack(null);
      }
    }
  }
}

function attachRemoteScreen(userId: string, stream: MediaStream) {
  const host = screenShareHost.value;
  if (!host) {
    return;
  }

  const existing = host.querySelector<HTMLVideoElement>(`video[data-user-id="${userId}"]`);
  if (existing) {
    existing.srcObject = stream;
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'screen-share-tile';
  wrap.dataset.userId = userId;

  const label = document.createElement('strong');
  label.textContent = `${displayName(userId)} is sharing`;

  const video = document.createElement('video');
  video.dataset.userId = userId;
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;

  wrap.append(label, video);
  host.appendChild(wrap);

  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    wrap.remove();
  });
}

function closePeer(userId: string) {
  peers.get(userId)?.close();
  peers.delete(userId);
  queuedCandidates.delete(userId);
  delete peerStates[userId];
  remoteAudio.value?.querySelector(`[data-user-id="${userId}"]`)?.remove();
  screenShareHost.value?.querySelector(`[data-user-id="${userId}"]`)?.remove();
}

function cleanup() {
  intentionallyClosed = true;
  clearHeartbeat();
  clearReconnectTimer();
  navigator.mediaDevices?.removeEventListener('devicechange', loadDevices);
  for (const userId of peers.keys()) {
    closePeer(userId);
  }
  stopLocalAudio();
  void stopScreenShare();
  micStarted.value = false;
  socket?.close();
  socket = null;
}

function stopLocalAudio() {
  rawLocalStream?.getTracks().forEach((track) => track.stop());
  localStream?.getTracks().forEach((track) => track.stop());
  rawLocalStream = null;
  localStream = null;
  micGainNode = null;
  void audioContext?.close();
  audioContext = null;
}

function setLocalTracksEnabled(enabled: boolean) {
  localStream?.getAudioTracks().forEach((track) => {
    track.enabled = enabled;
  });
  rawLocalStream?.getAudioTracks().forEach((track) => {
    track.enabled = enabled;
  });
}

function send(message: SignalMessage) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function registerUser(user: string | UserSummary) {
  if (typeof user === 'string') {
    return user;
  }
  userNames[user.id] = user.displayName || `Guest ${user.id.slice(0, 4)}`;
  return user.id;
}

function displayName(userId: string) {
  return userNames[userId] || (userId === currentUserId.value ? props.displayName : `Guest ${userId.slice(0, 4)}`);
}

function initials(userId: string) {
  return displayName(userId)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .padEnd(2, userId[0]?.toUpperCase() ?? 'M')
    .slice(0, 2);
}
</script>

<template>
  <section class="room-shell">
    <aside class="server-rail" aria-label="Workspace switcher">
      <div class="server-pill active">{{ roomTag }}</div>
      <div class="server-pill">+</div>
      <div class="server-pill muted-pill">?</div>
    </aside>

    <aside class="channel-sidebar">
      <div class="workspace-card">
        <p class="eyebrow">Mikcort</p>
        <strong>Room {{ roomId }}</strong>
      </div>

      <div class="voice-dock">
        <div class="dock-user">
          <span class="avatar">{{ initials(currentUserId) }}</span>
          <div>
            <strong>{{ displayName(currentUserId) }}</strong>
            <small>{{ deafened ? 'Audio off' : voiceState }}</small>
          </div>
        </div>

        <div class="dock-actions" aria-label="Voice controls">
          <button
            type="button"
            class="icon-button"
            :class="{ active: micStarted && !muted, danger: muted }"
            :data-tooltip="micStarted ? (muted ? 'Unmute mic' : 'Mute mic') : 'Start mic'"
            :title="micStarted ? (muted ? 'Unmute microphone' : 'Mute microphone') : 'Start microphone'"
            @click="micStarted ? toggleMute() : startMicrophone()"
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
            @click="toggleDeafen"
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
            @click="settingsOpen = !settingsOpen"
          >
            <Settings :size="20" />
          </button>

          <button
            type="button"
            class="icon-button"
            :class="{ active: sharingScreen }"
            :data-tooltip="sharingScreen ? 'Stop sharing' : 'Share screen'"
            :title="sharingScreen ? 'Stop screen share' : 'Share screen'"
            @click="toggleScreenShare"
          >
            <MonitorUp :size="20" />
          </button>

          <button type="button" class="icon-button leave-button" data-tooltip="Leave room" title="Leave room" @click="leave">
            <PhoneOff :size="20" />
          </button>
        </div>
      </div>
    </aside>

    <main class="voice-stage">
      <header class="stage-header">
        <div>
          <p class="eyebrow">Voice channel</p>
          <h1>Lounge</h1>
        </div>
        <div class="connection-pill">
          <span :class="['dot', wsOpen ? 'online' : 'offline']"></span>
          {{ connectionLabel }}
        </div>
      </header>

      <p v-if="error" class="error">{{ error }}</p>

      <section class="voice-room-panel">
        <div class="voice-room-copy">
          <p>{{ status }}</p>
          <strong>{{ users.length }} connected in Lounge</strong>
        </div>

        <div class="room-presence">
          <div class="presence-row">
            <span class="dot online"></span>
            <span>{{ displayName(currentUserId) }}</span>
            <small>{{ deafened ? 'deafened' : voiceState.toLowerCase() }}</small>
          </div>
        </div>
      </section>

      <section ref="screenShareHost" class="screen-share-grid" aria-label="Screen shares"></section>
    </main>

    <aside class="member-sidebar">
      <div class="panel-heading">
        <h2>Members</h2>
        <span>{{ users.length }}/5</span>
      </div>
      <ul class="user-list">
        <li v-for="userId in users" :key="userId">
          <span class="avatar">{{ initials(userId) }}</span>
          <div>
            <strong>{{ displayName(userId) }}</strong>
            <small>{{ userId === currentUserId ? (deafened ? 'deafened' : muted ? 'muted' : 'local') : peerStates[userId] ?? 'waiting' }}</small>
          </div>
        </li>
      </ul>
    </aside>

    <aside v-if="settingsOpen" class="settings-drawer" aria-label="Audio settings">
      <div class="drawer-header">
        <div>
          <p class="eyebrow">Device setup</p>
          <h2>Audio settings</h2>
        </div>
        <button type="button" class="icon-button close-button" data-tooltip="Close" title="Close settings" @click="settingsOpen = false">
          <X :size="18" />
        </button>
      </div>

      <div class="settings-grid drawer-grid">
        <label>
          Microphone
          <select v-model="selectedInputId" @change="applyAudioSettings">
            <option v-for="device in inputDevices" :key="device.deviceId" :value="device.deviceId">
              {{ device.label || 'Microphone' }}
            </option>
          </select>
        </label>

        <label>
          Output
          <select v-model="selectedOutputId" @change="applyAudioSettings">
            <option v-for="device in outputDevices" :key="device.deviceId" :value="device.deviceId">
              {{ device.label || 'Speaker' }}
            </option>
          </select>
        </label>

        <label>
          Mic gain
          <input v-model.number="inputGain" type="range" min="0" max="200" @input="updateMicGain" />
          <small>{{ inputGain }}%</small>
        </label>

        <label>
          Output volume
          <input v-model.number="outputVolume" type="range" min="0" max="100" @input="updateRemoteAudioSettings" />
          <small>{{ deafened ? 'Muted' : `${outputVolume}%` }}</small>
        </label>
      </div>

      <div class="toggle-row drawer-toggles">
        <label>
          <input v-model="noiseSuppression" type="checkbox" @change="applyAudioSettings" />
          Noise suppression
        </label>
        <label>
          <input v-model="echoCancellation" type="checkbox" @change="applyAudioSettings" />
          Echo cancellation
        </label>
        <label>
          <input v-model="autoGainControl" type="checkbox" @change="applyAudioSettings" />
          Auto gain
        </label>
      </div>
    </aside>

    <div ref="remoteAudio" class="remote-audio" aria-hidden="true"></div>
  </section>
</template>
