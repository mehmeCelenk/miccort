export type SignalType =
  | 'join-room'
  | 'user-joined'
  | 'user-left'
  | 'offer'
  | 'answer'
  | 'ice-candidate'
  | 'chat-message'
  | 'room-users'
  | 'ping'
  | 'pong'
  | 'error';

export interface SignalMessage {
  type: SignalType;
  roomId?: string;
  userId?: string;
  targetUserId?: string;
  payload?: unknown;
}

export interface RoomUsersPayload {
  users: Array<string | UserSummary>;
  self?: UserSummary;
}

export interface ErrorPayload {
  message: string;
}

export interface JoinPayload {
  displayName: string;
  password?: string;
}

export interface UserSummary {
  id: string;
  displayName?: string;
}

export interface ChatPayload {
  text?: string;
  sentAt?: number;
}

export interface ChatMessage {
  id: string;
  userId: string;
  text: string;
  sentAt: number;
}

export interface RemoteScreenShare {
  userId: string;
  stream: MediaStream;
}

export type SenderSource = 'mic' | 'screen';
export type ShortcutAction = 'mute' | 'deafen';
