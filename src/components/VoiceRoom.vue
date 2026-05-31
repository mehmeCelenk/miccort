<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { Headphones, Maximize2, Minimize2, MonitorUp, Mic, MicOff, PhoneOff, Settings, Volume2, VolumeX, X } from 'lucide-vue-next';

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

interface RemoteScreenShare {
  userId: string;
  stream: MediaStream;
}

type SenderSource = 'mic' | 'screen';
type ShortcutAction = 'mute' | 'deafen';

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
const micStarting = ref(false);
const muted = ref(false);
const deafened = ref(false);
const mutedBeforeDeafen = ref<boolean | null>(null);
const settingsOpen = ref(false);
const sharingScreen = ref(false);
const wsOpen = ref(false);
const remoteAudio = ref<HTMLDivElement | null>(null);
const inputDevices = ref<MediaDeviceInfo[]>([]);
const outputDevices = ref<MediaDeviceInfo[]>([]);
const selectedInputId = ref('');
const selectedOutputId = ref('');
const inputGain = ref(100);
const inputSensitivity = ref(0);
const outputVolume = ref(100);
const selectedScreenFps = ref(30);
const noiseSuppression = ref(true);
const echoCancellation = ref(true);
const autoGainControl = ref(true);
const muteShortcut = ref(readStoredValue('mikcort:shortcut:mute', ''));
const deafenShortcut = ref(readStoredValue('mikcort:shortcut:deafen', ''));
const capturingShortcut = ref<ShortcutAction | null>(null);
const peerStates = reactive<Record<string, string>>({});
const userNames = reactive<Record<string, string>>({});
const memberVolumes = reactive<Record<string, number>>({});
const screenVolumes = reactive<Record<string, number>>({});
const speakingUsers = reactive<Record<string, boolean>>({});
const remoteScreens = ref<RemoteScreenShare[]>([]);
const activeMemberVolumeUser = ref<string | null>(null);
const activeScreenMenuUser = ref<string | null>(null);
const fullscreenScreenUser = ref<string | null>(null);
const viewingScreenUser = ref<string | null>(null);
const screenShareMenuOpen = ref(false);
const sidebarWidth = ref(clampSidebarWidth(Number(readStoredValue('mikcort:sidebar-width', '240')) || 240));

let socket: WebSocket | null = null;
let rawLocalStream: MediaStream | null = null;
let localStream: MediaStream | null = null;
let screenStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let feedbackAudioContext: AudioContext | null = null;
let micGainNode: GainNode | null = null;
let micSensitivityNode: GainNode | null = null;
let micSensitivityAnalyser: AnalyserNode | null = null;
let micSensitivityTimer: number | undefined;
let reconnectTimer: number | undefined;
let heartbeatTimer: number | undefined;
let errorTimer: number | undefined;
let intentionallyClosed = false;
let stopSidebarResize: (() => void) | null = null;
const peers = new Map<string, RTCPeerConnection>();
const queuedCandidates = new Map<string, RTCIceCandidateInit[]>();
const remoteAnalyzers = new Map<string, { context: AudioContext; timer: number }>();
const screenVideoElements = new Map<string, HTMLVideoElement>();
const senderSources = new WeakMap<RTCRtpSender, SenderSource>();
const makingOffers = new Set<string>();
const speakingUntil = new Map<string, number>();
const peerRecoveryTimers = new Map<string, number>();
const peerHeartbeats = new Map<string, { channel: RTCDataChannel; timer?: number; lastSeen: number }>();
const peerRecoveryAttempts = new Map<string, number>();
const remoteTrackRecoveryTimers = new Map<string, number>();
const pendingOffers = new Map<string, RTCOfferOptions | undefined>();
const otherUsers = computed(() => users.value.filter((userId) => userId !== currentUserId.value));
const connectionLabel = computed(() => (wsOpen.value ? 'Connected' : 'Offline'));
const viewedScreenShare = computed(() => remoteScreens.value.find((share) => share.userId === viewingScreenUser.value) ?? null);
const viewedScreenUserId = computed(() => viewedScreenShare.value?.userId ?? '');
const voiceState = computed(() => {
  if (!micStarted.value) {
    return 'Ready';
  }
  return muted.value ? 'Muted' : 'Live';
});

onMounted(() => {
  connect();
  void startMicrophone();
  void loadDevices();
  window.addEventListener('keydown', handleKeydown);
  navigator.mediaDevices?.addEventListener('devicechange', loadDevices);
});
onBeforeUnmount(cleanup);

watch(error, (message) => {
  clearErrorTimer();
  if (!message) {
    return;
  }
  errorTimer = window.setTimeout(() => {
    error.value = '';
    errorTimer = undefined;
  }, 2000);
});

function connect() {
  clearReconnectTimer();
  clearHeartbeat();
  intentionallyClosed = false;
  socket = new WebSocket(props.serverUrl);

  socket.addEventListener('open', () => {
    wsOpen.value = true;
    error.value = '';
    status.value = micStarted.value ? 'Microphone is on.' : 'Joined room. Microphone is opening...';
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

function clearErrorTimer() {
  if (errorTimer) {
    window.clearTimeout(errorTimer);
    errorTimer = undefined;
  }
}

async function startMicrophone() {
  if (micStarted.value || micStarting.value) {
    return;
  }
  micStarting.value = true;
  try {
    error.value = '';
    await openMicrophone();
    if (localStream) {
      startSpeakingDetection(currentUserId.value, localStream);
    }
    muted.value = false;
    micStarted.value = true;
    status.value = 'Microphone is on.';

    for (const userId of otherUsers.value) {
      await ensurePeer(userId, true);
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Microphone permission failed.';
  } finally {
    micStarting.value = false;
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
  if (localStream) {
    startSpeakingDetection(currentUserId.value, localStream);
  }
  muted.value = wasMuted;
  setLocalTracksEnabled(!wasMuted);

  for (const peer of peers.values()) {
    const nextTrack = localStream?.getAudioTracks()[0] ?? null;
    for (const sender of peer.getSenders()) {
      if (senderSources.get(sender) === 'mic') {
        await sender.replaceTrack(nextTrack);
        if (nextTrack) {
          configureSender(sender, nextTrack, 'mic');
        }
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
  micSensitivityNode = audioContext.createGain();
  micSensitivityAnalyser = audioContext.createAnalyser();
  micGainNode = audioContext.createGain();
  const destination = audioContext.createMediaStreamDestination();

  micSensitivityAnalyser.fftSize = 1024;
  micSensitivityNode.gain.value = 1;

  source.connect(micSensitivityAnalyser);
  source.connect(micSensitivityNode);
  micSensitivityNode.connect(micGainNode);
  micGainNode.connect(destination);
  startInputSensitivityMonitor();
  return destination.stream;
}

function updateMicGain() {
  if (micGainNode) {
    micGainNode.gain.value = inputGain.value / 100;
  }
}

function startInputSensitivityMonitor() {
  stopInputSensitivityMonitor();
  if (!audioContext || !micSensitivityNode || !micSensitivityAnalyser) {
    return;
  }

  const samples = new Uint8Array(micSensitivityAnalyser.fftSize);
  micSensitivityTimer = window.setInterval(() => {
    if (!audioContext || !micSensitivityNode || !micSensitivityAnalyser) {
      return;
    }

    if (inputSensitivity.value <= 0 || muted.value) {
      micSensitivityNode.gain.setTargetAtTime(1, audioContext.currentTime, 0.025);
      return;
    }

    micSensitivityAnalyser.getByteTimeDomainData(samples);
    let total = 0;
    for (const sample of samples) {
      const centered = (sample - 128) / 128;
      total += centered * centered;
    }

    const rms = Math.sqrt(total / samples.length);
    const threshold = inputSensitivity.value / 100;
    const targetGain = rms < threshold ? 0.04 : 1;
    micSensitivityNode.gain.setTargetAtTime(targetGain, audioContext.currentTime, targetGain === 1 ? 0.015 : 0.08);
  }, 60);
}

function stopInputSensitivityMonitor() {
  if (micSensitivityTimer) {
    window.clearInterval(micSensitivityTimer);
    micSensitivityTimer = undefined;
  }
}

function updateRemoteAudioSettings() {
  remoteAudio.value?.querySelectorAll('audio').forEach((element) => {
    const audio = element as HTMLAudioElement & {
      setSinkId?: (sinkId: string) => Promise<void>;
    };
    audio.volume = remoteElementVolume(audio);
    if (selectedOutputId.value && audio.setSinkId) {
      void audio.setSinkId(selectedOutputId.value).catch(() => {
        error.value = 'Selected output device is not available.';
      });
    }
  });
}

function remoteElementVolume(audio: HTMLAudioElement) {
  if (deafened.value) {
    return 0;
  }
  const userId = audio.dataset.userId ?? '';
  const source = audio.dataset.source;
  if (source === 'screen' && viewingScreenUser.value !== userId) {
    return 0;
  }
  const sourceVolume = source === 'screen' ? (screenVolumes[userId] ?? 100) : (memberVolumes[userId] ?? 100);
  return (outputVolume.value / 100) * (sourceVolume / 100);
}

function screenShareVideoConstraints(): MediaTrackConstraints {
  const fps = normalizedScreenFps();
  return {
    frameRate: { ideal: fps, max: fps },
    width: { ideal: 1280, max: 1920 },
    height: { ideal: 720, max: 1080 },
  };
}

function normalizedScreenFps() {
  return Number(selectedScreenFps.value) >= 60 ? 60 : 30;
}

function toggleMute() {
  if (!localStream) {
    return;
  }
  const wasMuted = muted.value;
  const wasDeafened = deafened.value;
  if (muted.value && deafened.value) {
    deafened.value = false;
    mutedBeforeDeafen.value = null;
  }
  muted.value = !muted.value;
  setLocalTracksEnabled(!muted.value);
  if (muted.value) {
    speakingUsers[currentUserId.value] = false;
  }
  updateRemoteAudioSettings();
  playVoiceFeedback(!wasMuted && muted.value ? 'mute' : 'unmute', wasDeafened);
}

function toggleDeafen() {
  const nextDeafened = !deafened.value;
  const wasDeafened = deafened.value;
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
  playVoiceFeedback(nextDeafened ? 'deafen' : 'undeafen', wasDeafened);
}

function playVoiceFeedback(
  type: 'mute' | 'unmute' | 'deafen' | 'undeafen' | 'screen-start' | 'screen-stop' | 'user-join' | 'user-leave',
  wasDeafened = false,
) {
  const isScreenFeedback = type === 'screen-start' || type === 'screen-stop';
  if (((deafened.value && type !== 'deafen') || (wasDeafened && type !== 'undeafen')) && !isScreenFeedback) {
    return;
  }

  feedbackAudioContext ??= new AudioContext();
  const context = feedbackAudioContext;
  void context.resume().then(() => {
    const now = context.currentTime;
    const master = context.createGain();
    const volume = isScreenFeedback ? 0.48 : 0.3 * (outputVolume.value / 100);
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(volume, now + 0.012);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.36);
    master.connect(context.destination);

    const tones = {
      mute: [520, 330],
      unmute: [330, 560],
      deafen: [420, 250],
      undeafen: [250, 420],
      'screen-start': [440, 660, 880],
      'screen-stop': [760, 540, 360],
      'user-join': [392, 523, 659],
      'user-leave': [659, 523, 392],
    }[type];

    tones.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = now + index * 0.09;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(1, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start(start);
      oscillator.stop(start + 0.16);
    });
  });
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
        const previousUserId = currentUserId.value;
        currentUserId.value = message.userId;
        if (previousUserId !== currentUserId.value && localStream) {
          stopSpeakingDetection(previousUserId);
          startSpeakingDetection(currentUserId.value, localStream);
        }
      }
      userNames[currentUserId.value] = payload.self?.displayName || props.displayName;
      const existingUsers = (payload.users ?? []).map(registerUser);
      users.value = unique([currentUserId.value, ...existingUsers]);
      if (localStream) {
        for (const userId of otherUsers.value) {
          await ensurePeer(userId, true);
        }
      }
      break;
    }
    case 'user-joined':
      if (message.userId && message.userId !== currentUserId.value) {
        registerUser((message.payload as UserSummary | undefined) ?? message.userId);
        users.value = unique([...users.value, message.userId]);
        playVoiceFeedback('user-join');
        if (localStream) {
          await ensurePeer(message.userId, false);
        }
      }
      break;
    case 'user-left':
      if (message.userId) {
        users.value = users.value.filter((userId) => userId !== message.userId);
        closePeer(message.userId);
        if (message.userId !== currentUserId.value) {
          playVoiceFeedback('user-leave');
        }
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
        if (peer && peer.signalingState === 'have-local-offer') {
          await peer.setRemoteDescription(message.payload as RTCSessionDescriptionInit).catch(() => undefined);
          await flushQueuedCandidates(message.userId, peer);
          await flushPendingOffer(message.userId, peer);
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
      if (!peer.getSenders().some((sender) => senderSources.get(sender) === 'mic')) {
        addSender(peer, track, localStream, 'mic');
      }
    }
  }

  if (screenStream) {
    for (const track of screenStream.getTracks()) {
      if (!peer.getSenders().some((sender) => sender.track === track)) {
        addSender(peer, track, screenStream, 'screen');
      }
    }
  }

  if (makeOffer) {
    await requestPeerOffer(userId, peer);
  }

  return peer;
}

async function requestPeerOffer(userId: string, peer: RTCPeerConnection, options?: RTCOfferOptions) {
  const offerSent = await sendOffer(userId, peer, options);
  if (!offerSent && peer.signalingState !== 'closed') {
    pendingOffers.set(userId, mergeOfferOptions(pendingOffers.get(userId), options));
  }
  return offerSent;
}

async function flushPendingOffer(userId: string, peer: RTCPeerConnection) {
  if (peer.signalingState !== 'stable' || socket?.readyState !== WebSocket.OPEN || !pendingOffers.has(userId)) {
    return;
  }

  const options = pendingOffers.get(userId);
  pendingOffers.delete(userId);
  await requestPeerOffer(userId, peer, options);
}

function mergeOfferOptions(current: RTCOfferOptions | undefined, next: RTCOfferOptions | undefined) {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  return {
    ...current,
    ...next,
    iceRestart: Boolean(current.iceRestart || next.iceRestart),
  };
}

async function sendOffer(userId: string, peer: RTCPeerConnection, options?: RTCOfferOptions) {
  if (makingOffers.has(userId) || peer.signalingState !== 'stable') {
    return false;
  }

  makingOffers.add(userId);
  try {
    const offer = await peer.createOffer(options);
    if (peer.signalingState !== 'stable') {
      return false;
    }

    await peer.setLocalDescription(offer);
    send({
      type: 'offer',
      roomId: props.roomId,
      userId: currentUserId.value,
      targetUserId: userId,
      payload: offer,
    });
    return true;
  } catch {
    return false;
  } finally {
    makingOffers.delete(userId);
  }
}

function createPeer(userId: string) {
  const peer = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  setupPeerHeartbeat(userId, peer.createDataChannel('heartbeat', { ordered: false, maxRetransmits: 0 }));
  peer.ondatachannel = (event) => {
    if (event.channel.label === 'heartbeat') {
      setupPeerHeartbeat(userId, event.channel);
    }
  };

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

  peer.onconnectionstatechange = () => handlePeerConnectionState(userId, peer);
  peer.oniceconnectionstatechange = () => handlePeerConnectionState(userId, peer);
  peer.onsignalingstatechange = () => {
    void flushPendingOffer(userId, peer);
  };

  peer.ontrack = (event) => {
    if (event.track.kind === 'audio') {
      const source = event.streams[0]?.getVideoTracks().length ? 'screen' : 'mic';
      attachRemoteAudio(userId, event.streams[0], source);
    } else if (event.track.kind === 'video') {
      attachRemoteScreen(userId, event.streams[0]);
    }
  };

  return peer;
}

function handlePeerConnectionState(userId: string, peer: RTCPeerConnection) {
  const state = peer.connectionState === 'new' ? peer.iceConnectionState : peer.connectionState;
  peerStates[userId] = state;

  if (isPeerHealthy(peer)) {
    clearPeerRecovery(userId);
    peerRecoveryAttempts.delete(userId);
    if (status.value === 'Reconnecting voice...') {
      status.value = 'Microphone is on.';
    }
    return;
  }

  if (state === 'disconnected' || state === 'failed') {
    schedulePeerRecovery(userId, peer, state === 'failed' ? 0 : 2500);
  }
}

function schedulePeerRecovery(userId: string, peer: RTCPeerConnection, delay: number) {
  if (intentionallyClosed || peerRecoveryTimers.has(userId)) {
    return;
  }

  status.value = 'Reconnecting voice...';
  const timer = window.setTimeout(() => {
    peerRecoveryTimers.delete(userId);
    if (intentionallyClosed || peer.connectionState === 'closed') {
      return;
    }
    if (isPeerHealthy(peer)) {
      return;
    }
    void recoverPeer(userId, peer);
  }, delay);
  peerRecoveryTimers.set(userId, timer);
}

async function recoverPeer(userId: string, peer: RTCPeerConnection) {
  const attempts = (peerRecoveryAttempts.get(userId) ?? 0) + 1;
  peerRecoveryAttempts.set(userId, attempts);

  if (attempts >= 2) {
    await rebuildPeer(userId);
    return;
  }

  if (socket?.readyState !== WebSocket.OPEN || peer.signalingState !== 'stable') {
    schedulePeerRecovery(userId, peer, 3000);
    return;
  }

  const offerSent = await requestPeerOffer(userId, peer, { iceRestart: true });
  if (!offerSent) {
    await rebuildPeer(userId);
    return;
  }

  if (!isPeerHealthy(peer)) {
    schedulePeerRecovery(userId, peer, 5000);
  }
}

async function rebuildPeer(userId: string) {
  if (intentionallyClosed || socket?.readyState !== WebSocket.OPEN || !users.value.includes(userId)) {
    return;
  }

  closePeer(userId);
  peerRecoveryAttempts.delete(userId);
  status.value = 'Reconnecting voice...';
  await ensurePeer(userId, shouldInitiatePeerRecovery(userId));
}

function shouldInitiatePeerRecovery(userId: string) {
  return currentUserId.value.localeCompare(userId) > 0;
}

function isPeerHealthy(peer: RTCPeerConnection) {
  return peer.connectionState === 'connected' || peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed';
}

function setupPeerHeartbeat(userId: string, channel: RTCDataChannel) {
  const existing = peerHeartbeats.get(userId);
  if (existing?.channel === channel) {
    return;
  }
  clearPeerHeartbeat(userId);

  peerHeartbeats.set(userId, { channel, lastSeen: performance.now() });
  channel.addEventListener('message', (event) => handlePeerHeartbeatMessage(userId, channel, event));
  channel.addEventListener('open', () => startPeerHeartbeat(userId, channel));
  channel.addEventListener('close', () => {
    if (peerHeartbeats.get(userId)?.channel === channel) {
      clearPeerHeartbeat(userId);
    }
  });

  if (channel.readyState === 'open') {
    startPeerHeartbeat(userId, channel);
  }
}

function startPeerHeartbeat(userId: string, channel: RTCDataChannel) {
  const heartbeat = peerHeartbeats.get(userId);
  if (!heartbeat || heartbeat.channel !== channel || heartbeat.timer) {
    return;
  }

  heartbeat.timer = window.setInterval(() => {
    if (channel.readyState !== 'open') {
      clearPeerHeartbeat(userId);
      const peer = peers.get(userId);
      if (peer) {
        schedulePeerRecovery(userId, peer, 0);
      }
      return;
    }
    const staleFor = performance.now() - heartbeat.lastSeen;
    if (staleFor > 30_000) {
      const peer = peers.get(userId);
      if (peer) {
        schedulePeerRecovery(userId, peer, 0);
      }
      return;
    }
    channel.send('ping');
  }, 10_000);
}

function handlePeerHeartbeatMessage(userId: string, channel: RTCDataChannel, event: MessageEvent) {
  const heartbeat = peerHeartbeats.get(userId);
  if (!heartbeat || heartbeat.channel !== channel) {
    return;
  }

  heartbeat.lastSeen = performance.now();
  if (event.data === 'ping' && channel.readyState === 'open') {
    channel.send('pong');
  }
}

function clearPeerHeartbeat(userId: string) {
  const heartbeat = peerHeartbeats.get(userId);
  if (!heartbeat) {
    return;
  }
  if (heartbeat.timer) {
    window.clearInterval(heartbeat.timer);
  }
  peerHeartbeats.delete(userId);
}

function clearPeerRecovery(userId: string) {
  const timer = peerRecoveryTimers.get(userId);
  if (!timer) {
    return;
  }
  window.clearTimeout(timer);
  peerRecoveryTimers.delete(userId);
}

function scheduleRemoteTrackRecovery(userId: string, source: 'mic' | 'screen') {
  const key = remoteTrackRecoveryKey(userId, source);
  if (remoteTrackRecoveryTimers.has(key)) {
    return;
  }

  const timer = window.setTimeout(() => {
    remoteTrackRecoveryTimers.delete(key);
    const peer = peers.get(userId);
    if (peer && !intentionallyClosed) {
      schedulePeerRecovery(userId, peer, 0);
    }
  }, 8_000);
  remoteTrackRecoveryTimers.set(key, timer);
}

function clearRemoteTrackRecovery(userId: string, source?: 'mic' | 'screen') {
  for (const [key, timer] of remoteTrackRecoveryTimers) {
    if (key === remoteTrackRecoveryKey(userId, source ?? 'mic') || key === remoteTrackRecoveryKey(userId, source ?? 'screen')) {
      window.clearTimeout(timer);
      remoteTrackRecoveryTimers.delete(key);
    }
  }
}

function remoteTrackRecoveryKey(userId: string, source: 'mic' | 'screen') {
  return `${userId}:${source}`;
}

async function receiveOffer(userId: string, offer: RTCSessionDescriptionInit) {
  const peer = await ensurePeer(userId, false);
  if (peer.signalingState === 'have-local-offer') {
    await peer.setLocalDescription({ type: 'rollback' }).catch(() => undefined);
  } else if (peer.signalingState !== 'stable') {
    return;
  }

  await peer.setRemoteDescription(offer).catch(() => undefined);
  const remoteOfferState = peer.signalingState as string;
  if (remoteOfferState !== 'have-remote-offer') {
    return;
  }
  await flushQueuedCandidates(userId, peer);

  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer).catch(() => undefined);
  const answeredState = peer.signalingState as string;
  if (answeredState !== 'stable') {
    return;
  }
  send({
    type: 'answer',
    roomId: props.roomId,
    userId: currentUserId.value,
    targetUserId: userId,
    payload: answer,
  });
  await flushPendingOffer(userId, peer);
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

function attachRemoteAudio(userId: string, stream: MediaStream | undefined, source: 'mic' | 'screen') {
  const host = remoteAudio.value;
  if (!host || !stream) {
    return;
  }

  const existing = host.querySelector(`[data-user-id="${userId}"][data-source="${source}"]`) as HTMLAudioElement | null;
  if (existing) {
    if (existing.srcObject !== stream) {
      existing.srcObject = stream;
      attachRemoteTrackRecovery(userId, stream, source, existing);
      if (source === 'mic') {
        startSpeakingDetection(userId, stream);
      }
    }
    startRemoteAudioPlayback(userId, source, existing);
    updateRemoteAudioSettings();
    return;
  }

  const audio = document.createElement('audio');
  audio.dataset.userId = userId;
  audio.dataset.source = source;
  audio.autoplay = true;
  audio.volume = remoteElementVolume(audio);
  audio.srcObject = stream;
  host.appendChild(audio);
  if (source === 'mic') {
    startSpeakingDetection(userId, stream);
  }
  attachRemoteTrackRecovery(userId, stream, source, audio);
  startRemoteAudioPlayback(userId, source, audio);
  updateRemoteAudioSettings();
}

function attachRemoteTrackRecovery(userId: string, stream: MediaStream, source: 'mic' | 'screen', audio: HTMLAudioElement) {
  stream.getTracks().forEach((track) => {
    track.addEventListener('mute', () => scheduleRemoteTrackRecovery(userId, source));
    track.addEventListener('unmute', () => clearRemoteTrackRecovery(userId, source));
    track.addEventListener('ended', () => {
      clearRemoteTrackRecovery(userId, source);
      audio.remove();
      if (source === 'mic') {
        stopSpeakingDetection(userId);
      }
    });
  });
}

function startRemoteAudioPlayback(userId: string, source: 'mic' | 'screen', audio: HTMLAudioElement) {
  const tryPlay = () => {
    if (!audio.isConnected) {
      return;
    }
    void audio.play().then(
      () => clearRemoteTrackRecovery(userId, source),
      () => scheduleRemoteTrackRecovery(userId, source),
    );
  };

  audio.addEventListener('canplay', tryPlay, { once: true });
  tryPlay();
}

function setMemberVolume(userId: string, value: number) {
  memberVolumes[userId] = value;
  updateRemoteAudioSettings();
}

function setMemberVolumeFromEvent(userId: string, event: Event) {
  setMemberVolume(userId, Number((event.target as HTMLInputElement).value));
}

function toggleMemberVolumePopover(userId: string) {
  if (userId === currentUserId.value) {
    return;
  }
  activeScreenMenuUser.value = null;
  screenShareMenuOpen.value = false;
  activeMemberVolumeUser.value = activeMemberVolumeUser.value === userId ? null : userId;
}

function setScreenVolume(userId: string, value: number) {
  screenVolumes[userId] = value;
  updateRemoteAudioSettings();
}

function setScreenVolumeFromEvent(userId: string, event: Event) {
  setScreenVolume(userId, Number((event.target as HTMLInputElement).value));
}

function openScreenMenu(userId: string) {
  activeMemberVolumeUser.value = null;
  screenShareMenuOpen.value = false;
  activeScreenMenuUser.value = userId;
}

function closePopovers() {
  activeMemberVolumeUser.value = null;
  activeScreenMenuUser.value = null;
  screenShareMenuOpen.value = false;
}

function handleKeydown(event: KeyboardEvent) {
  if (capturingShortcut.value) {
    event.preventDefault();
    const shortcut = keyboardShortcut(event);
    if (shortcut) {
      setShortcut(capturingShortcut.value, shortcut);
    }
    return;
  }

  if (event.key === 'Escape') {
    fullscreenScreenUser.value = null;
    closePopovers();
    return;
  }

  if (event.repeat || isTypingTarget(event.target)) {
    return;
  }

  const shortcut = keyboardShortcut(event);
  if (muteShortcut.value && shortcut === muteShortcut.value) {
    event.preventDefault();
    toggleMute();
  } else if (deafenShortcut.value && shortcut === deafenShortcut.value) {
    event.preventDefault();
    toggleDeafen();
  }
}

function startShortcutCapture(action: ShortcutAction) {
  capturingShortcut.value = action;
}

function setShortcut(action: ShortcutAction, shortcut: string) {
  if (action === 'mute') {
    muteShortcut.value = shortcut;
    localStorage.setItem('mikcort:shortcut:mute', shortcut);
  } else {
    deafenShortcut.value = shortcut;
    localStorage.setItem('mikcort:shortcut:deafen', shortcut);
  }
  capturingShortcut.value = null;
}

function clearShortcut(action: ShortcutAction) {
  if (action === 'mute') {
    muteShortcut.value = '';
    localStorage.removeItem('mikcort:shortcut:mute');
  } else {
    deafenShortcut.value = '';
    localStorage.removeItem('mikcort:shortcut:deafen');
  }
}

function keyboardShortcut(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    capturingShortcut.value = null;
    return '';
  }
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  const key = event.code || event.key;
  if (!['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'].includes(key)) {
    parts.push(key);
  }
  return parts.length ? parts.join('+') : '';
}

function formatShortcut(shortcut: string) {
  return shortcut
    .replaceAll('Control', 'Ctrl')
    .replaceAll('Key', '')
    .replaceAll('Digit', '')
    .replaceAll('Arrow', '');
}

function isTypingTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  if (!element) {
    return false;
  }
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable;
}

function readStoredValue(key: string, fallback: string) {
  return localStorage.getItem(key) || fallback;
}

async function toggleScreenShare() {
  if (sharingScreen.value) {
    await stopScreenShare();
  } else {
    screenShareMenuOpen.value = !screenShareMenuOpen.value;
  }
}

async function startScreenShare(fps = selectedScreenFps.value) {
  try {
    error.value = '';
    selectedScreenFps.value = fps === 60 ? 60 : 30;
    screenShareMenuOpen.value = false;
    const videoConstraints = screenShareVideoConstraints();
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints,
      audio: true,
    });
    sharingScreen.value = true;
    status.value = `Sharing your screen at ${selectedScreenFps.value} FPS.`;
    playVoiceFeedback('screen-start');

    const [track] = screenStream.getVideoTracks();
    await track?.applyConstraints(videoConstraints).catch(() => undefined);
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

function addSender(peer: RTCPeerConnection, track: MediaStreamTrack, stream: MediaStream, source: SenderSource) {
  const sender = peer.addTrack(track, stream);
  senderSources.set(sender, source);
  configureSender(sender, track, source);
  return sender;
}

function configureSender(sender: RTCRtpSender, track: MediaStreamTrack, source: SenderSource) {
  const parameters = sender.getParameters();
  parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];

  if (track.kind === 'video') {
    parameters.degradationPreference = 'maintain-framerate';
    parameters.encodings[0] = {
      ...parameters.encodings[0],
      maxBitrate: 1_500_000,
      maxFramerate: normalizedScreenFps(),
    };
  } else if (track.kind === 'audio' && source === 'screen') {
    parameters.encodings[0] = {
      ...parameters.encodings[0],
      maxBitrate: 64_000,
    };
  }

  void sender.setParameters(parameters).catch(() => undefined);
}

async function stopScreenShare() {
  if (!screenStream && !sharingScreen.value) {
    return;
  }

  const stoppedStream = screenStream;
  const stoppedTrackIds = new Set(stoppedStream?.getTracks().map((track) => track.id) ?? []);
  screenStream = null;
  sharingScreen.value = false;
  screenShareMenuOpen.value = false;
  stoppedStream?.getTracks().forEach((track) => track.stop());
  if (stoppedStream) {
    playVoiceFeedback('screen-stop');
  }

  for (const [userId, peer] of peers) {
    for (const sender of peer.getSenders()) {
      if (sender.track && stoppedTrackIds.has(sender.track.id)) {
        senderSources.delete(sender);
        peer.removeTrack(sender);
      }
    }
    if (peer.signalingState === 'stable') {
      await requestPeerOffer(userId, peer);
    }
  }
  status.value = micStarted.value ? 'Microphone is on.' : 'Ready';
}

function attachRemoteScreen(userId: string, stream: MediaStream) {
  const existing = remoteScreens.value.find((share) => share.userId === userId);
  if (existing) {
    existing.stream = stream;
    const video = screenVideoElements.get(userId);
    if (video) {
      video.srcObject = stream;
    }
    return;
  }

  remoteScreens.value = [...remoteScreens.value, { userId, stream }];

  stream.getVideoTracks()[0]?.addEventListener('ended', () => removeRemoteScreen(userId));
  stream.addEventListener('removetrack', () => {
    if (!stream.getVideoTracks().some((track) => track.readyState === 'live')) {
      removeRemoteScreen(userId);
    }
  });
  window.setTimeout(() => {
    if (!stream.getVideoTracks().some((track) => track.readyState === 'live')) {
      removeRemoteScreen(userId);
    }
  }, 0);
}

function setScreenVideoElement(element: Element | null, userId: string) {
  if (!(element instanceof HTMLVideoElement)) {
    screenVideoElements.delete(userId);
    return;
  }
  screenVideoElements.set(userId, element);
  const share = remoteScreens.value.find((item) => item.userId === userId);
  if (share && element.srcObject !== share.stream) {
    element.srcObject = share.stream;
  }
}

function removeRemoteScreen(userId: string) {
  remoteScreens.value = remoteScreens.value.filter((share) => share.userId !== userId);
  screenVideoElements.delete(userId);
  remoteAudio.value?.querySelectorAll(`[data-user-id="${userId}"][data-source="screen"]`).forEach((element) => element.remove());
  delete screenVolumes[userId];
  clearRemoteTrackRecovery(userId, 'screen');
  if (activeScreenMenuUser.value === userId) {
    activeScreenMenuUser.value = null;
  }
  if (fullscreenScreenUser.value === userId) {
    fullscreenScreenUser.value = null;
  }
  if (viewingScreenUser.value === userId) {
    viewingScreenUser.value = null;
    updateRemoteAudioSettings();
  }
}

function toggleScreenFullscreen(userId: string) {
  fullscreenScreenUser.value = fullscreenScreenUser.value === userId ? null : userId;
  activeScreenMenuUser.value = null;
}

function viewScreenShare(userId: string) {
  viewingScreenUser.value = userId;
  activeMemberVolumeUser.value = null;
  activeScreenMenuUser.value = null;
  screenShareMenuOpen.value = false;
  updateRemoteAudioSettings();
}

function toggleScreenShareView(userId: string) {
  if (userId === currentUserId.value) {
    return;
  }
  if (viewingScreenUser.value === userId) {
    stopViewingScreenShare();
  } else {
    viewScreenShare(userId);
  }
}

function stopViewingScreenShare() {
  fullscreenScreenUser.value = null;
  viewingScreenUser.value = null;
  activeScreenMenuUser.value = null;
  updateRemoteAudioSettings();
}

function isUserSharingScreen(userId: string) {
  return userId === currentUserId.value ? sharingScreen.value : remoteScreens.value.some((share) => share.userId === userId);
}

function screenShareBadgeLabel(userId: string) {
  return viewingScreenUser.value === userId ? 'Watching' : 'Live';
}

function clampSidebarWidth(value: number) {
  return Math.min(420, Math.max(220, Math.round(value)));
}

function saveSidebarWidth() {
  localStorage.setItem('mikcort:sidebar-width', String(sidebarWidth.value));
}

function startSidebarResize(event: PointerEvent) {
  event.preventDefault();
  stopSidebarResize?.();

  const startX = event.clientX;
  const startWidth = sidebarWidth.value;

  document.body.classList.add('resizing-sidebar');

  const handlePointerMove = (moveEvent: PointerEvent) => {
    sidebarWidth.value = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
  };

  const finishResize = () => {
    document.body.classList.remove('resizing-sidebar');
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', finishResize);
    window.removeEventListener('pointercancel', finishResize);
    stopSidebarResize = null;
    saveSidebarWidth();
  };

  stopSidebarResize = finishResize;
  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', finishResize);
  window.addEventListener('pointercancel', finishResize);
}

function resizeSidebarWithKeyboard(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    return;
  }
  event.preventDefault();

  if (event.key === 'Home') {
    sidebarWidth.value = 220;
  } else if (event.key === 'End') {
    sidebarWidth.value = 420;
  } else {
    sidebarWidth.value = clampSidebarWidth(sidebarWidth.value + (event.key === 'ArrowRight' ? 16 : -16));
  }

  saveSidebarWidth();
}

function closePeer(userId: string) {
  clearPeerRecovery(userId);
  clearPeerHeartbeat(userId);
  peers.get(userId)?.close();
  peers.delete(userId);
  queuedCandidates.delete(userId);
  makingOffers.delete(userId);
  pendingOffers.delete(userId);
  peerRecoveryAttempts.delete(userId);
  clearRemoteTrackRecovery(userId);
  delete peerStates[userId];
  delete memberVolumes[userId];
  delete screenVolumes[userId];
  delete speakingUsers[userId];
  stopSpeakingDetection(userId);
  removeRemoteScreen(userId);
  remoteAudio.value?.querySelectorAll(`[data-user-id="${userId}"]`).forEach((element) => element.remove());
}

function cleanup() {
  intentionallyClosed = true;
  stopSidebarResize?.();
  clearErrorTimer();
  clearHeartbeat();
  clearReconnectTimer();
  window.removeEventListener('keydown', handleKeydown);
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
  stopSpeakingDetection(currentUserId.value);
  rawLocalStream?.getTracks().forEach((track) => track.stop());
  localStream?.getTracks().forEach((track) => track.stop());
  stopInputSensitivityMonitor();
  rawLocalStream = null;
  localStream = null;
  micGainNode = null;
  micSensitivityNode = null;
  micSensitivityAnalyser = null;
  void audioContext?.close();
  audioContext = null;
  void feedbackAudioContext?.close();
  feedbackAudioContext = null;
}

function startSpeakingDetection(userId: string, stream: MediaStream) {
  stopSpeakingDetection(userId);
  const track = stream.getAudioTracks()[0];
  if (!track) {
    return;
  }

  const context = new AudioContext();
  void context.resume();
  const source = context.createMediaStreamSource(new MediaStream([track]));
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.35;
  const samples = new Uint8Array(analyser.fftSize);
  source.connect(analyser);
  let noiseFloor = 1.8;

  const timer = window.setInterval(() => {
    if (track.readyState !== 'live' || track.muted || (userId === currentUserId.value && muted.value)) {
      speakingUsers[userId] = false;
      return;
    }

    analyser.getByteTimeDomainData(samples);
    let total = 0;
    for (const sample of samples) {
      const centered = sample - 128;
      total += centered * centered;
    }
    const rms = Math.sqrt(total / samples.length);
    noiseFloor = Math.min(12, noiseFloor * 0.96 + rms * 0.04);
    const threshold = Math.max(3.2, noiseFloor + 1.6);
    const now = performance.now();
    if (rms > threshold) {
      speakingUntil.set(userId, now + 520);
    }
    speakingUsers[userId] = (speakingUntil.get(userId) ?? 0) > now;
  }, 70);

  remoteAnalyzers.set(userId, { context, timer });
  track.addEventListener('ended', () => stopSpeakingDetection(userId), { once: true });
}

function stopSpeakingDetection(userId: string) {
  const analyzer = remoteAnalyzers.get(userId);
  if (!analyzer) {
    return;
  }
  window.clearInterval(analyzer.timer);
  void analyzer.context.close();
  remoteAnalyzers.delete(userId);
  speakingUntil.delete(userId);
  speakingUsers[userId] = false;
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
  const letters = displayName(userId)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

  return letters || 'M';
}
</script>

<template>
  <section class="room-shell" :style="{ '--sidebar-width': `${sidebarWidth}px` }" @click="closePopovers">
    <aside class="channel-sidebar">
      <div
        class="sidebar-resizer"
        role="separator"
        aria-label="Resize members sidebar"
        aria-orientation="vertical"
        tabindex="0"
        @pointerdown="startSidebarResize"
        @keydown="resizeSidebarWithKeyboard"
      ></div>

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
            @click.stop="toggleMemberVolumePopover(userId)"
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
              @click.stop="toggleScreenShareView(userId)"
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
                  @input="setMemberVolumeFromEvent(userId, $event)"
                />
                <small>{{ memberVolumes[userId] ?? 100 }}%</small>
              </label>
            </div>
          </li>
        </ul>
      </div>

      <div class="voice-dock">
        <div class="dock-user">
          <span class="avatar">{{ initials(currentUserId) }}</span>
          <div>
            <strong>{{ displayName(currentUserId) }}</strong>
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

          <div class="share-control">
            <button
              type="button"
              class="icon-button"
              :class="{ active: sharingScreen, selected: screenShareMenuOpen }"
              :data-tooltip="sharingScreen ? 'Stop sharing' : 'Share screen'"
              :title="sharingScreen ? 'Stop screen share' : 'Share screen'"
              @click.stop="toggleScreenShare"
            >
              <MonitorUp :size="20" />
            </button>
            <div v-if="screenShareMenuOpen" class="share-menu popover-panel" @click.stop>
              <button type="button" class="menu-action" @click="startScreenShare(30)">
                <MonitorUp :size="16" />
                30 FPS
              </button>
              <button type="button" class="menu-action" @click="startScreenShare(60)">
                <MonitorUp :size="16" />
                60 FPS
              </button>
            </div>
          </div>

          <button type="button" class="icon-button leave-button" data-tooltip="Leave room" title="Leave room" @click="leave">
            <PhoneOff :size="20" />
          </button>
        </div>
      </div>
    </aside>

    <main class="voice-stage">
      <header class="stage-header">
        <div class="stage-title">
          <h1>Lounge</h1>
          <span>Room {{ roomId }}</span>
          <span>{{ users.length }} connected</span>
          <span>{{ status }}</span>
        </div>
        <div class="connection-pill">
          <span :class="['dot', wsOpen ? 'online' : 'offline']"></span>
          {{ connectionLabel }}
        </div>
      </header>

      <p v-if="error" class="error">{{ error }}</p>

      <div v-if="sharingScreen" class="screen-status">
        <MonitorUp :size="16" />
        <span>You are sharing your screen</span>
        <strong>{{ selectedScreenFps }} FPS</strong>
      </div>

      <section v-if="viewedScreenUserId" class="screen-share-grid" aria-label="Screen share">
        <article
          :key="viewedScreenUserId"
          :class="['screen-share-tile', { fullscreen: fullscreenScreenUser === viewedScreenUserId }]"
          @contextmenu.prevent.stop="openScreenMenu(viewedScreenUserId)"
          @click.stop="closePopovers"
        >
          <div class="screen-share-header">
            <strong>{{ displayName(viewedScreenUserId) }} is sharing</strong>
            <button
              type="button"
              class="icon-button compact-button"
              :data-tooltip="fullscreenScreenUser === viewedScreenUserId ? 'Exit fullscreen' : 'Fullscreen'"
              :title="fullscreenScreenUser === viewedScreenUserId ? 'Exit fullscreen' : 'Fullscreen'"
              @click.stop="toggleScreenFullscreen(viewedScreenUserId)"
            >
              <Minimize2 v-if="fullscreenScreenUser === viewedScreenUserId" :size="18" />
              <Maximize2 v-else :size="18" />
            </button>
            <button
              type="button"
              class="icon-button compact-button screen-stop-watch"
              data-tooltip="Stop watching"
              title="Stop watching"
              @click.stop="stopViewingScreenShare"
            >
              <X :size="18" />
            </button>
          </div>

          <div class="screen-video-wrap">
            <video
              :ref="(element) => setScreenVideoElement(element as Element | null, viewedScreenUserId)"
              :data-user-id="viewedScreenUserId"
              autoplay
              playsinline
              muted
              @dblclick.stop="toggleScreenFullscreen(viewedScreenUserId)"
            ></video>

            <div v-if="activeScreenMenuUser === viewedScreenUserId" class="screen-menu popover-panel" @click.stop>
              <button type="button" class="menu-action" @click="toggleScreenFullscreen(viewedScreenUserId)">
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
                  @input="setScreenVolumeFromEvent(viewedScreenUserId, $event)"
                />
                <small>{{ screenVolumes[viewedScreenUserId] ?? 100 }}%</small>
              </label>
            </div>
          </div>
        </article>
      </section>
    </main>

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

      <div class="settings-sections">
        <section class="settings-section" aria-labelledby="device-settings-heading">
          <h3 id="device-settings-heading">Devices</h3>
          <div class="settings-list">
            <label class="setting-item">
              <span class="setting-label">Microphone</span>
              <select v-model="selectedInputId" @change="applyAudioSettings">
                <option v-for="device in inputDevices" :key="device.deviceId" :value="device.deviceId">
                  {{ device.label || 'Microphone' }}
                </option>
              </select>
            </label>

            <label class="setting-item">
              <span class="setting-label">Output</span>
              <select v-model="selectedOutputId" @change="applyAudioSettings">
                <option v-for="device in outputDevices" :key="device.deviceId" :value="device.deviceId">
                  {{ device.label || 'Speaker' }}
                </option>
              </select>
            </label>
          </div>
        </section>

        <section class="settings-section" aria-labelledby="level-settings-heading">
          <h3 id="level-settings-heading">Levels</h3>
          <div class="settings-list">
            <label class="setting-item">
              <span class="setting-label">Mic gain</span>
              <input v-model.number="inputGain" type="range" min="0" max="200" @input="updateMicGain" />
              <small>{{ inputGain }}%</small>
            </label>

            <label class="setting-item">
              <span class="setting-label">Input sensitivity</span>
              <input v-model.number="inputSensitivity" type="range" min="0" max="10" step="0.5" />
              <small>{{ inputSensitivity > 0 ? `${inputSensitivity}%` : 'Off' }}</small>
            </label>

            <label class="setting-item">
              <span class="setting-label">Output volume</span>
              <input v-model.number="outputVolume" type="range" min="0" max="100" @input="updateRemoteAudioSettings" />
              <small>{{ deafened ? 'Muted' : `${outputVolume}%` }}</small>
            </label>

          </div>
        </section>

        <section class="settings-section" aria-labelledby="shortcut-settings-heading">
          <h3 id="shortcut-settings-heading">Shortcuts</h3>
          <div class="settings-list">
            <div class="setting-item shortcut-row">
              <span class="setting-label">Mute shortcut</span>
              <div class="shortcut-control">
                <button type="button" class="shortcut-button" @click="startShortcutCapture('mute')">
                  {{ capturingShortcut === 'mute' ? 'Press keys...' : muteShortcut ? formatShortcut(muteShortcut) : 'Not set' }}
                </button>
                <button
                  v-if="muteShortcut"
                  type="button"
                  class="icon-button compact-button shortcut-clear"
                  data-tooltip="Clear shortcut"
                  title="Clear shortcut"
                  @click="clearShortcut('mute')"
                >
                  <X :size="15" />
                </button>
              </div>
            </div>

            <div class="setting-item shortcut-row">
              <span class="setting-label">Deafen shortcut</span>
              <div class="shortcut-control">
                <button type="button" class="shortcut-button" @click="startShortcutCapture('deafen')">
                  {{ capturingShortcut === 'deafen' ? 'Press keys...' : deafenShortcut ? formatShortcut(deafenShortcut) : 'Not set' }}
                </button>
                <button
                  v-if="deafenShortcut"
                  type="button"
                  class="icon-button compact-button shortcut-clear"
                  data-tooltip="Clear shortcut"
                  title="Clear shortcut"
                  @click="clearShortcut('deafen')"
                >
                  <X :size="15" />
                </button>
              </div>
            </div>
          </div>
        </section>

        <section class="settings-section" aria-labelledby="processing-settings-heading">
          <h3 id="processing-settings-heading">Processing</h3>
          <div class="settings-list settings-toggle-list">
            <label class="setting-item setting-toggle">
              <input v-model="noiseSuppression" type="checkbox" @change="applyAudioSettings" />
              <span>Noise suppression</span>
            </label>
            <label class="setting-item setting-toggle">
              <input v-model="echoCancellation" type="checkbox" @change="applyAudioSettings" />
              <span>Echo cancellation</span>
            </label>
            <label class="setting-item setting-toggle">
              <input v-model="autoGainControl" type="checkbox" @change="applyAudioSettings" />
              <span>Auto gain</span>
            </label>
          </div>
        </section>
      </div>
    </aside>

    <div ref="remoteAudio" class="remote-audio" aria-hidden="true"></div>
  </section>
</template>
