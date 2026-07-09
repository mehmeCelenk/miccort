import { nextTick, ref, type Ref } from 'vue';
import type { ChatMessage, ChatPayload, SignalMessage } from './types';
import { normalizedChatText } from './chat';

interface UseRoomChatOptions {
  roomId: () => string;
  currentUserId: Ref<string>;
  wsOpen: Ref<boolean>;
  sendSignal: (message: SignalMessage) => void;
}

export function useRoomChat({ roomId, currentUserId, wsOpen, sendSignal }: UseRoomChatOptions) {
  const chatLog = ref<HTMLDivElement | null>(null);
  const chatDraft = ref('');
  const chatMessages = ref<ChatMessage[]>([]);
  const chatOpen = ref(false);
  const unreadChatCount = ref(0);

  function sendChatMessage() {
    const text = normalizedChatText(chatDraft.value);
    if (!text || !wsOpen.value) {
      return;
    }

    chatOpen.value = true;
    unreadChatCount.value = 0;
    chatDraft.value = '';
    const sentAt = Date.now();
    chatMessages.value = [
      ...chatMessages.value,
      {
        id: crypto.randomUUID(),
        userId: currentUserId.value,
        text,
        sentAt,
      },
    ];
    scrollChatToBottom();
    sendSignal({
      type: 'chat-message',
      roomId: roomId(),
      userId: currentUserId.value,
      payload: {
        text,
        sentAt,
      },
    });
  }

  function appendChatMessage(userId: string, payload: ChatPayload) {
    const text = normalizedChatText(payload.text ?? '');
    if (!text) {
      return;
    }

    chatMessages.value = [
      ...chatMessages.value,
      {
        id: crypto.randomUUID(),
        userId,
        text,
        sentAt: payload.sentAt && Number.isFinite(payload.sentAt) ? payload.sentAt : Date.now(),
      },
    ];
    if (!chatOpen.value) {
      unreadChatCount.value += 1;
    }
    scrollChatToBottom();
  }

  function toggleChat() {
    chatOpen.value = !chatOpen.value;
    if (chatOpen.value) {
      unreadChatCount.value = 0;
      scrollChatToBottom();
    }
  }

  function scrollChatToBottom() {
    void nextTick(() => {
      if (chatLog.value) {
        chatLog.value.scrollTop = chatLog.value.scrollHeight;
      }
    });
  }

  return {
    chatDraft,
    chatLog,
    chatMessages,
    chatOpen,
    unreadChatCount,
    appendChatMessage,
    sendChatMessage,
    toggleChat,
  };
}
