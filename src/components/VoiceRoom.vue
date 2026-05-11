<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

type SignalType =
  | 'join-room'
  | 'user-joined'
  | 'user-left'
  | 'offer'
  | 'answer'
  | 'ice-candidate'
  | 'room-users'
  | 'error';

interface SignalMessage {
  type: SignalType;
  roomId?: string;
  userId?: string;
  targetUserId?: string;
  payload?: unknown;
}

interface RoomUsersPayload {
  users: string[];
}

interface ErrorPayload {
  message: string;
}

const props = defineProps<{
  roomId: string;
  serverUrl: string;
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
const wsOpen = ref(false);
const remoteAudio = ref<HTMLDivElement | null>(null);
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

let socket: WebSocket | null = null;
let rawLocalStream: MediaStream | null = null;
let localStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let micGainNode: GainNode | null = null;
const peers = new Map<string, RTCPeerConnection>();
const queuedCandidates = new Map<string, RTCIceCandidateInit[]>();

const otherUsers = computed(() => users.value.filter((userId) => userId !== currentUserId.value));

onMounted(() => {
  connect();
  void loadDevices();
  navigator.mediaDevices?.addEventListener('devicechange', loadDevices);
});
onBeforeUnmount(cleanup);

function connect() {
  socket = new WebSocket(props.serverUrl);

  socket.addEventListener('open', () => {
    wsOpen.value = true;
    status.value = 'Joined room. Start your microphone when ready.';
    send({
      type: 'join-room',
      roomId: props.roomId,
      userId: currentUserId.value,
    });
  });

  socket.addEventListener('message', (event: MessageEvent<string>) => {
    void handleSignal(JSON.parse(event.data) as SignalMessage);
  });

  socket.addEventListener('close', () => {
    wsOpen.value = false;
    status.value = 'Disconnected from signaling server.';
  });

  socket.addEventListener('error', () => {
    error.value = 'Could not connect to the signaling server.';
  });
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
  const volume = outputVolume.value / 100;
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
  muted.value = !muted.value;
  setLocalTracksEnabled(!muted.value);
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
      users.value = unique([currentUserId.value, ...(payload.users ?? [])]);
      break;
    }
    case 'user-joined':
      if (message.userId && message.userId !== currentUserId.value) {
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
    attachRemoteAudio(userId, event.streams[0]);
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

function closePeer(userId: string) {
  peers.get(userId)?.close();
  peers.delete(userId);
  queuedCandidates.delete(userId);
  delete peerStates[userId];
  remoteAudio.value?.querySelector(`[data-user-id="${userId}"]`)?.remove();
}

function cleanup() {
  navigator.mediaDevices?.removeEventListener('devicechange', loadDevices);
  for (const userId of peers.keys()) {
    closePeer(userId);
  }
  stopLocalAudio();
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
</script>

<template>
  <section class="room">
    <header class="room-header">
      <div>
        <p class="eyebrow">Room {{ roomId }}</p>
        <h1>Voice chat</h1>
      </div>
      <button type="button" class="danger" @click="leave">Leave</button>
    </header>

    <div class="status-row">
      <span :class="['dot', wsOpen ? 'online' : 'offline']"></span>
      <span>{{ status }}</span>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div class="controls">
      <button type="button" :disabled="micStarted" @click="startMicrophone">
        Start microphone
      </button>
      <button type="button" class="secondary" :disabled="!micStarted" @click="toggleMute">
        {{ muted ? 'Unmute' : 'Mute' }}
      </button>
    </div>

    <section class="panel settings-panel">
      <div class="panel-heading">
        <h2>Audio settings</h2>
        <span>{{ micStarted ? 'live' : 'ready' }}</span>
      </div>

      <div class="settings-grid">
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
          Microphone volume
          <input v-model.number="inputGain" type="range" min="0" max="200" @input="updateMicGain" />
          <small>{{ inputGain }}%</small>
        </label>

        <label>
          Speaker volume
          <input v-model.number="outputVolume" type="range" min="0" max="100" @input="updateRemoteAudioSettings" />
          <small>{{ outputVolume }}%</small>
        </label>
      </div>

      <div class="toggle-row">
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
    </section>

    <section class="panel">
      <div class="panel-heading">
        <h2>Users</h2>
        <span>{{ users.length }}/5</span>
      </div>
      <ul class="user-list">
        <li v-for="userId in users" :key="userId">
          <span>{{ userId === currentUserId ? 'You' : userId.slice(0, 8) }}</span>
          <small>{{ userId === currentUserId ? (muted ? 'muted' : 'local') : peerStates[userId] ?? 'waiting' }}</small>
        </li>
      </ul>
    </section>

    <div ref="remoteAudio" class="remote-audio" aria-hidden="true"></div>
  </section>
</template>
