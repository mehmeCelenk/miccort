import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { RemoteScreenShare } from './types';

interface UseScreenShareOptions {
  activeMemberVolumeUser: Ref<string | null>;
  clearRemoteTrackRecovery: (userId: string, source?: 'mic' | 'screen') => void;
  currentUserId: Ref<string>;
  error: Ref<string>;
  micStarted: Ref<boolean>;
  otherUsers: ComputedRef<string[]>;
  peers: Map<string, RTCPeerConnection>;
  playVoiceFeedback: (type: 'screen-start' | 'screen-stop') => void;
  remoteAudio: Ref<HTMLDivElement | null>;
  requestPeerOffer: (userId: string, peer: RTCPeerConnection, options?: RTCOfferOptions) => Promise<boolean>;
  screenVolumes: Record<string, number>;
  selectedScreenFps: Ref<number>;
  senderSources: WeakMap<RTCRtpSender, 'mic' | 'screen'>;
  status: Ref<string>;
  updateRemoteAudioSettings: () => void;
  ensurePeer: (userId: string, makeOffer: boolean) => Promise<RTCPeerConnection>;
}

export function useScreenShare({
  activeMemberVolumeUser,
  clearRemoteTrackRecovery,
  currentUserId,
  error,
  micStarted,
  otherUsers,
  peers,
  playVoiceFeedback,
  remoteAudio,
  requestPeerOffer,
  screenVolumes,
  selectedScreenFps,
  senderSources,
  status,
  updateRemoteAudioSettings,
  ensurePeer,
}: UseScreenShareOptions) {
  const sharingScreen = ref(false);
  const remoteScreens = ref<RemoteScreenShare[]>([]);
  const activeScreenMenuUser = ref<string | null>(null);
  const fullscreenScreenUser = ref<string | null>(null);
  const viewingScreenUser = ref<string | null>(null);
  const screenShareMenuOpen = ref(false);
  const screenStream = ref<MediaStream | null>(null);
  const screenVideoElements = new Map<string, HTMLVideoElement>();

  const viewedScreenShare = computed(() => remoteScreens.value.find((share) => share.userId === viewingScreenUser.value) ?? null);
  const viewedScreenUserId = computed(() => viewedScreenShare.value?.userId ?? '');

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
      screenStream.value = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: true,
      });
      sharingScreen.value = true;
      status.value = `Sharing your screen at ${selectedScreenFps.value} FPS.`;
      playVoiceFeedback('screen-start');

      const [track] = screenStream.value.getVideoTracks();
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

  async function stopScreenShare() {
    if (!screenStream.value && !sharingScreen.value) {
      return;
    }

    const stoppedStream = screenStream.value;
    const stoppedTrackIds = new Set(stoppedStream?.getTracks().map((track) => track.id) ?? []);
    screenStream.value = null;
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

  return {
    activeScreenMenuUser,
    attachRemoteScreen,
    fullscreenScreenUser,
    isUserSharingScreen,
    normalizedScreenFps,
    remoteScreens,
    removeRemoteScreen,
    screenShareBadgeLabel,
    screenShareMenuOpen,
    screenStream,
    setScreenVideoElement,
    sharingScreen,
    startScreenShare,
    stopScreenShare,
    stopViewingScreenShare,
    toggleScreenFullscreen,
    toggleScreenShare,
    toggleScreenShareView,
    viewedScreenShare,
    viewedScreenUserId,
    viewingScreenUser,
  };
}
