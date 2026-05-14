<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
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
const peerStates = reactive<Record<string, string>>({});
const userNames = reactive<Record<string, string>>({});
const memberVolumes = reactive<Record<string, number>>({});
const screenVolumes = reactive<Record<string, number>>({});
const speakingUsers = reactive<Record<string, boolean>>({});
const remoteScreens = ref<RemoteScreenShare[]>([]);
const activeMemberVolumeUser = ref<string | null>(null);
const activeScreenMenuUser = ref<string | null>(null);
const fullscreenScreenUser = ref<string | null>(null);

let socket: WebSocket | null = null;
let rawLocalStream: MediaStream | null = null;
let localStream: MediaStream | null = null;
let screenStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let micGainNode: GainNode | null = null;
let micSensitivityNode: GainNode | null = null;
let micSensitivityAnalyser: AnalyserNode | null = null;
let micSensitivityTimer: number | undefined;
let reconnectTimer: number | undefined;
let heartbeatTimer: number | undefined;
let intentionallyClosed = false;
const peers = new Map<string, RTCPeerConnection>();
const queuedCandidates = new Map<string, RTCIceCandidateInit[]>();
const remoteAnalyzers = new Map<string, { context: AudioContext; timer: number }>();
const screenVideoElements = new Map<string, HTMLVideoElement>();
const senderSources = new WeakMap<RTCRtpSender, SenderSource>();
const otherUsers = computed(() => users.value.filter((userId) => userId !== currentUserId.value));
const connectionLabel = computed(() => (wsOpen.value ? 'Connected' : 'Offline'));
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
  return Math.min(60, Math.max(30, Number(selectedScreenFps.value) || 30));
}

async function applyScreenFpsSettings() {
  selectedScreenFps.value = normalizedScreenFps();
  if (!screenStream) {
    return;
  }

  const constraints = screenShareVideoConstraints();
  await Promise.all(screenStream.getVideoTracks().map((track) => track.applyConstraints(constraints).catch(() => undefined)));

  for (const peer of peers.values()) {
    for (const sender of peer.getSenders()) {
      if (senderSources.get(sender) === 'screen' && sender.track?.kind === 'video') {
        configureSender(sender, sender.track, 'screen');
      }
    }
  }
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
    await sendOffer(userId, peer);
  }

  return peer;
}

async function sendOffer(userId: string, peer: RTCPeerConnection) {
  if (peer.signalingState !== 'stable') {
    return;
  }

  const offer = await peer.createOffer();
  if (peer.signalingState !== 'stable') {
    return;
  }

  await peer.setLocalDescription(offer);
  send({
    type: 'offer',
    roomId: props.roomId,
    userId: currentUserId.value,
    targetUserId: userId,
    payload: offer,
  });
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
      const source = event.streams[0]?.getVideoTracks().length ? 'screen' : 'mic';
      attachRemoteAudio(userId, event.streams[0], source);
    } else if (event.track.kind === 'video') {
      attachRemoteScreen(userId, event.streams[0]);
    }
  };

  return peer;
}

async function receiveOffer(userId: string, offer: RTCSessionDescriptionInit) {
  const peer = await ensurePeer(userId, false);
  if (peer.signalingState === 'have-local-offer') {
    await peer.setLocalDescription({ type: 'rollback' });
  } else if (peer.signalingState !== 'stable') {
    return;
  }

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

function attachRemoteAudio(userId: string, stream: MediaStream, source: 'mic' | 'screen') {
  const host = remoteAudio.value;
  if (!host || host.querySelector(`[data-user-id="${userId}"][data-source="${source}"]`)) {
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
  stream.getTracks().forEach((track) => {
    track.addEventListener('ended', () => {
      audio.remove();
      if (source === 'mic') {
        stopSpeakingDetection(userId);
      }
    });
  });
  updateRemoteAudioSettings();
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
  activeScreenMenuUser.value = userId;
}

function closePopovers() {
  activeMemberVolumeUser.value = null;
  activeScreenMenuUser.value = null;
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    fullscreenScreenUser.value = null;
    closePopovers();
  }
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
    const videoConstraints = screenShareVideoConstraints();
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints,
      audio: true,
    });
    sharingScreen.value = true;

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
  const stoppedStream = screenStream;
  const stoppedTrackIds = new Set(stoppedStream?.getTracks().map((track) => track.id) ?? []);
  screenStream = null;
  sharingScreen.value = false;
  stoppedStream?.getTracks().forEach((track) => track.stop());

  for (const [userId, peer] of peers) {
    for (const sender of peer.getSenders()) {
      if (sender.track && stoppedTrackIds.has(sender.track.id)) {
        senderSources.delete(sender);
        peer.removeTrack(sender);
      }
    }
    if (peer.signalingState === 'stable') {
      await sendOffer(userId, peer);
    }
  }
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
  if (activeScreenMenuUser.value === userId) {
    activeScreenMenuUser.value = null;
  }
  if (fullscreenScreenUser.value === userId) {
    fullscreenScreenUser.value = null;
  }
}

function toggleScreenFullscreen(userId: string) {
  fullscreenScreenUser.value = fullscreenScreenUser.value === userId ? null : userId;
  activeScreenMenuUser.value = null;
}

function closePeer(userId: string) {
  peers.get(userId)?.close();
  peers.delete(userId);
  queuedCandidates.delete(userId);
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
}

function startSpeakingDetection(userId: string, stream: MediaStream) {
  stopSpeakingDetection(userId);
  const track = stream.getAudioTracks()[0];
  if (!track) {
    return;
  }

  const context = new AudioContext();
  const source = context.createMediaStreamSource(new MediaStream([track]));
  const analyser = context.createAnalyser();
  const samples = new Uint8Array(analyser.fftSize);
  source.connect(analyser);

  const timer = window.setInterval(() => {
    analyser.getByteTimeDomainData(samples);
    let total = 0;
    for (const sample of samples) {
      const centered = sample - 128;
      total += centered * centered;
    }
    speakingUsers[userId] = Math.sqrt(total / samples.length) > 8;
  }, 120);

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
  <section class="room-shell" @click="closePopovers">
    <aside class="channel-sidebar">
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
              <small>{{ userId === currentUserId ? (deafened ? 'deafened' : muted ? 'muted' : 'local') : peerStates[userId] ?? 'waiting' }}</small>
            </div>
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
            <small>{{ deafened ? 'Audio off' : voiceState }}</small>
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
          <small class="stage-room-id">Room {{ roomId }}</small>
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

      <section v-if="remoteScreens.length" class="screen-share-grid" aria-label="Screen shares">
        <article
          v-for="share in remoteScreens"
          :key="share.userId"
          :class="['screen-share-tile', { fullscreen: fullscreenScreenUser === share.userId }]"
          @contextmenu.prevent.stop="openScreenMenu(share.userId)"
          @click.stop="closePopovers"
        >
          <div class="screen-share-header">
            <strong>{{ displayName(share.userId) }} is sharing</strong>
            <button
              type="button"
              class="icon-button compact-button"
              :data-tooltip="fullscreenScreenUser === share.userId ? 'Exit fullscreen' : 'Fullscreen'"
              :title="fullscreenScreenUser === share.userId ? 'Exit fullscreen' : 'Fullscreen'"
              @click.stop="toggleScreenFullscreen(share.userId)"
            >
              <Minimize2 v-if="fullscreenScreenUser === share.userId" :size="18" />
              <Maximize2 v-else :size="18" />
            </button>
          </div>

          <div class="screen-video-wrap">
            <video
              :ref="(element) => setScreenVideoElement(element as Element | null, share.userId)"
              :data-user-id="share.userId"
              autoplay
              playsinline
              muted
              @dblclick.stop="toggleScreenFullscreen(share.userId)"
            ></video>

            <div v-if="activeScreenMenuUser === share.userId" class="screen-menu popover-panel" @click.stop>
              <button type="button" class="menu-action" @click="toggleScreenFullscreen(share.userId)">
                <Minimize2 v-if="fullscreenScreenUser === share.userId" :size="16" />
                <Maximize2 v-else :size="16" />
                {{ fullscreenScreenUser === share.userId ? 'Exit fullscreen' : 'Fullscreen' }}
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
                  :value="screenVolumes[share.userId] ?? 100"
                  @input="setScreenVolumeFromEvent(share.userId, $event)"
                />
                <small>{{ screenVolumes[share.userId] ?? 100 }}%</small>
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
          Input sensitivity
          <input v-model.number="inputSensitivity" type="range" min="0" max="10" step="0.5" />
          <small>{{ inputSensitivity > 0 ? `${inputSensitivity}%` : 'Off' }}</small>
        </label>

        <label>
          Output volume
          <input v-model.number="outputVolume" type="range" min="0" max="100" @input="updateRemoteAudioSettings" />
          <small>{{ deafened ? 'Muted' : `${outputVolume}%` }}</small>
        </label>

        <label>
          Screen FPS
          <input v-model.number="selectedScreenFps" type="range" min="30" max="60" step="1" @input="applyScreenFpsSettings" />
          <small>{{ selectedScreenFps }} FPS</small>
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
