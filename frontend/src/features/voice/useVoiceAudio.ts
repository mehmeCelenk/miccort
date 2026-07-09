import { ref, type ComputedRef, type Ref } from 'vue';
import { usePersistentBoolean, usePersistentNumber, usePersistentString } from '../../composables/usePersistentStorage';

type VoiceFeedback =
  | 'mute'
  | 'unmute'
  | 'deafen'
  | 'undeafen'
  | 'screen-start'
  | 'screen-stop'
  | 'user-join'
  | 'user-leave';

interface UseVoiceAudioOptions {
  configureSender: (sender: RTCRtpSender, track: MediaStreamTrack, source: 'mic' | 'screen') => void;
  currentUserId: Ref<string>;
  ensurePeer: (userId: string, makeOffer: boolean) => Promise<RTCPeerConnection>;
  error: Ref<string>;
  getViewingScreenUser: () => string | null;
  memberVolumes: Record<string, number>;
  otherUsers: ComputedRef<string[]>;
  peers: Map<string, RTCPeerConnection>;
  remoteAudio: Ref<HTMLDivElement | null>;
  screenVolumes: Record<string, number>;
  senderSources: WeakMap<RTCRtpSender, 'mic' | 'screen'>;
  speakingUsers: Record<string, boolean>;
  startSpeakingDetection: (userId: string, stream: MediaStream) => void;
  status: Ref<string>;
  stopSpeakingDetection: (userId: string) => void;
}

export function useVoiceAudio({
  configureSender,
  currentUserId,
  ensurePeer,
  error,
  getViewingScreenUser,
  memberVolumes,
  otherUsers,
  peers,
  remoteAudio,
  screenVolumes,
  senderSources,
  speakingUsers,
  startSpeakingDetection,
  status,
  stopSpeakingDetection,
}: UseVoiceAudioOptions) {
  const micStarted = ref(false);
  const micStarting = ref(false);
  const muted = ref(false);
  const deafened = ref(false);
  const mutedBeforeDeafen = ref<boolean | null>(null);
  const localStream = ref<MediaStream | null>(null);
  const rawLocalStream = ref<MediaStream | null>(null);
  const inputDevices = ref<MediaDeviceInfo[]>([]);
  const outputDevices = ref<MediaDeviceInfo[]>([]);
  const selectedInputId = usePersistentString('mikcort:audio:input-device', '');
  const selectedOutputId = usePersistentString('mikcort:audio:output-device', '');
  const inputGain = usePersistentNumber('mikcort:audio:input-gain', 100, 0, 100);
  const inputSensitivity = usePersistentNumber('mikcort:audio:input-sensitivity', 2, 0, 10);
  const outputVolume = usePersistentNumber('mikcort:audio:output-volume', 100, 0, 100);
  const noiseSuppression = usePersistentBoolean('mikcort:audio:noise-suppression', true);
  const echoCancellation = usePersistentBoolean('mikcort:audio:echo-cancellation', true);
  const autoGainControl = usePersistentBoolean('mikcort:audio:auto-gain-control', true);

  let audioContext: AudioContext | null = null;
  let feedbackAudioContext: AudioContext | null = null;
  let micGainNode: GainNode | null = null;
  let micSensitivityNode: GainNode | null = null;
  let micSensitivityAnalyser: AnalyserNode | null = null;
  let micSensitivityTimer: number | undefined;

  async function startMicrophone() {
    if (micStarted.value || micStarting.value) {
      return;
    }
    micStarting.value = true;
    try {
      error.value = '';
      await openMicrophone();
      if (localStream.value) {
        startSpeakingDetection(currentUserId.value, localStream.value);
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

    if ((!selectedInputId.value || !inputDevices.value.some((device) => device.deviceId === selectedInputId.value)) && inputDevices.value[0]) {
      selectedInputId.value = inputDevices.value[0].deviceId;
    }
    if ((!selectedOutputId.value || !outputDevices.value.some((device) => device.deviceId === selectedOutputId.value)) && outputDevices.value[0]) {
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
    if (localStream.value) {
      startSpeakingDetection(currentUserId.value, localStream.value);
    }
    muted.value = wasMuted;
    setLocalTracksEnabled(!wasMuted);

    for (const peer of peers.values()) {
      const nextTrack = localStream.value?.getAudioTracks()[0] ?? null;
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
    rawLocalStream.value = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: selectedInputId.value ? { exact: selectedInputId.value } : undefined,
        noiseSuppression: noiseSuppression.value,
        echoCancellation: echoCancellation.value,
        autoGainControl: autoGainControl.value,
      },
    });
    localStream.value = buildProcessedMicrophoneStream(rawLocalStream.value);
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
    if (source === 'screen' && getViewingScreenUser() !== userId) {
      return 0;
    }
    const sourceVolume = source === 'screen' ? (screenVolumes[userId] ?? 100) : (memberVolumes[userId] ?? 100);
    return (outputVolume.value / 100) * (sourceVolume / 100);
  }

  function toggleMute() {
    if (!localStream.value) {
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
      if (localStream.value && !muted.value) {
        muted.value = true;
        setLocalTracksEnabled(false);
      }
    } else {
      const shouldRestoreMic = mutedBeforeDeafen.value === false;
      mutedBeforeDeafen.value = null;
      if (localStream.value && shouldRestoreMic) {
        muted.value = false;
        setLocalTracksEnabled(true);
      }
    }
    updateRemoteAudioSettings();
    playVoiceFeedback(nextDeafened ? 'deafen' : 'undeafen', wasDeafened);
  }

  function playVoiceFeedback(type: VoiceFeedback, wasDeafened = false) {
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

  function stopLocalAudio() {
    stopSpeakingDetection(currentUserId.value);
    rawLocalStream.value?.getTracks().forEach((track) => track.stop());
    localStream.value?.getTracks().forEach((track) => track.stop());
    stopInputSensitivityMonitor();
    rawLocalStream.value = null;
    localStream.value = null;
    micGainNode = null;
    micSensitivityNode = null;
    micSensitivityAnalyser = null;
    void audioContext?.close();
    audioContext = null;
    void feedbackAudioContext?.close();
    feedbackAudioContext = null;
  }

  function setLocalTracksEnabled(enabled: boolean) {
    localStream.value?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
    rawLocalStream.value?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  return {
    autoGainControl,
    deafened,
    echoCancellation,
    inputDevices,
    inputGain,
    inputSensitivity,
    loadDevices,
    localStream,
    micStarted,
    micStarting,
    muted,
    noiseSuppression,
    outputDevices,
    outputVolume,
    playVoiceFeedback,
    remoteElementVolume,
    selectedInputId,
    selectedOutputId,
    startMicrophone,
    stopLocalAudio,
    toggleDeafen,
    toggleMute,
    updateMicGain,
    updateRemoteAudioSettings,
    applyAudioSettings,
  };
}
