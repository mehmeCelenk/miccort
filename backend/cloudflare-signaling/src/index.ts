import { DurableObject } from "cloudflare:workers";

type SignalType =
  | "join-room"
  | "user-joined"
  | "user-left"
  | "offer"
  | "answer"
  | "ice-candidate"
  | "chat-message"
  | "room-users"
  | "ping"
  | "pong"
  | "error";

interface SignalMessage {
  type: SignalType;
  roomId?: string;
  userId?: string;
  targetUserId?: string;
  payload?: unknown;
}

interface ClientSession {
  socket: WebSocket;
  roomId: string;
  userId: string;
  displayName: string;
}

interface JoinPayload {
  displayName?: string;
  password?: string;
}

interface UserSummary {
  id: string;
  displayName: string;
}

interface RoomSummary {
  id: string;
  locked?: boolean;
  users: string[];
}

export interface Env {
  SIGNALING_HUB: DurableObjectNamespace<SignalingHub>;
}

export default {
  fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return new Response("ok");
    }

    if (url.pathname === "/rooms") {
      if (request.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }));
      }
      const id = env.SIGNALING_HUB.idFromName("global");
      return env.SIGNALING_HUB.get(id).fetch(request);
    }

    if (url.pathname !== "/ws") {
      return new Response("not found", { status: 404 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const id = env.SIGNALING_HUB.idFromName("global");
    return env.SIGNALING_HUB.get(id).fetch(request);
  },
};

export class SignalingHub extends DurableObject<Env> {
  private sessions = new Map<WebSocket, ClientSession>();
  private rooms = new Map<string, Map<string, ClientSession>>();
  private roomPasswords = new Map<string, string>();

  fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/rooms") {
      if (request.method !== "GET") {
        return withCors(new Response("method not allowed", { status: 405 }));
      }

      return withCors(Response.json({ rooms: this.roomSummaries() }));
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    server.addEventListener("message", (event) => this.handleMessage(server, event));
    server.addEventListener("close", () => this.leave(server));
    server.addEventListener("error", () => this.leave(server));

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private handleMessage(socket: WebSocket, event: MessageEvent) {
    if (typeof event.data !== "string") {
      this.send(socket, { type: "error", payload: { message: "expected text json message" } });
      return;
    }

    let message: SignalMessage;
    try {
      message = JSON.parse(event.data) as SignalMessage;
    } catch {
      this.send(socket, { type: "error", payload: { message: "invalid json" } });
      return;
    }

    switch (message.type) {
      case "join-room":
        this.join(socket, message.roomId, message.userId, readJoinPayload(message.payload));
        break;
      case "ping":
        this.pong(socket);
        break;
      case "offer":
      case "answer":
      case "ice-candidate":
        this.forward(socket, message);
        break;
      case "chat-message":
        this.broadcastRoom(socket, message);
        break;
      default:
        this.send(socket, { type: "error", payload: { message: "unknown message type" } });
    }
  }

  private join(
    socket: WebSocket,
    roomId?: string,
    requestedUserId?: string,
    payload: JoinPayload = {},
  ) {
    if (!roomId) {
      this.send(socket, { type: "error", payload: { message: "roomId is required" } });
      return;
    }

    this.leave(socket);

    const userId = requestedUserId || crypto.randomUUID();
    const displayName = payload.displayName?.trim() || `Guest ${userId.slice(0, 4)}`;
    const password = payload.password?.trim() ?? "";
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Map<string, ClientSession>();
      this.rooms.set(roomId, room);
      if (password) {
        this.roomPasswords.set(roomId, password);
      }
    } else if (!this.passwordMatches(roomId, password)) {
      this.send(socket, { type: "error", payload: { message: "room password is incorrect" } });
      return;
    }

    const previousSession = room.get(userId);
    if (previousSession && previousSession.socket !== socket) {
      this.sessions.delete(previousSession.socket);
      try {
        previousSession.socket.close(1000, "replaced by a newer connection");
      } catch {
        // The stale socket may already be gone; the room map below is the source of truth.
      }
    }

    const existingUsers = [...room.values()]
      .filter((session) => session.userId !== userId)
      .map(toUserSummary);
    const session = { socket, roomId, userId, displayName };
    room.set(userId, session);
    this.sessions.set(socket, session);

    this.send(socket, {
      type: "room-users",
      roomId,
      userId,
      payload: {
        users: existingUsers,
        self: toUserSummary(session),
      },
    });

    this.broadcast(roomId, {
      type: "user-joined",
      roomId,
      userId,
      payload: toUserSummary(session),
    }, userId);
  }

  private leave(socket: WebSocket) {
    const session = this.sessions.get(socket);
    if (!session) {
      return;
    }

    this.sessions.delete(socket);
    const room = this.rooms.get(session.roomId);
    if (!room) {
      return;
    }

    if (room.get(session.userId)?.socket !== socket) {
      return;
    }

    room.delete(session.userId);
    if (room.size === 0) {
      this.rooms.delete(session.roomId);
      this.roomPasswords.delete(session.roomId);
      return;
    }

    this.broadcast(session.roomId, {
      type: "user-left",
      roomId: session.roomId,
      userId: session.userId,
    });
  }

  private forward(socket: WebSocket, message: SignalMessage) {
    const session = this.sessions.get(socket);
    if (!session) {
      this.send(socket, { type: "error", payload: { message: "join a room before signaling" } });
      return;
    }

    if (!message.targetUserId) {
      this.send(socket, { type: "error", payload: { message: "targetUserId is required" } });
      return;
    }

    const target = this.rooms.get(session.roomId)?.get(message.targetUserId);
    if (!target) {
      this.send(socket, { type: "error", payload: { message: "target user is not in room" } });
      return;
    }

    this.send(target.socket, {
      ...message,
      roomId: session.roomId,
      userId: session.userId,
    });
  }

  private broadcastRoom(socket: WebSocket, message: SignalMessage) {
    const session = this.sessions.get(socket);
    if (!session) {
      this.send(socket, { type: "error", payload: { message: "join a room before sending chat" } });
      return;
    }

    this.broadcast(session.roomId, {
      ...message,
      roomId: session.roomId,
      userId: session.userId,
      targetUserId: undefined,
    }, session.userId);
  }

  private pong(socket: WebSocket) {
    const session = this.sessions.get(socket);
    this.send(socket, {
      type: "pong",
      roomId: session?.roomId,
      userId: session?.userId,
    });
  }

  private roomSummaries(): RoomSummary[] {
    return [...this.rooms.entries()]
      .map(([id, room]) => ({
        id,
        locked: this.roomPasswords.has(id) || undefined,
        users: this.roomPasswords.has(id)
          ? []
          : [...room.values()]
              .map((session) => session.displayName)
              .filter(Boolean)
              .sort((a, b) => a.localeCompare(b)),
      }))
      .filter((room) => room.locked || room.users.length > 0)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private passwordMatches(roomId: string, password: string) {
    const roomPassword = this.roomPasswords.get(roomId);
    return !roomPassword || roomPassword === password;
  }

  private broadcast(roomId: string, message: SignalMessage, exceptUserId?: string) {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    for (const session of room.values()) {
      if (session.userId !== exceptUserId) {
        this.send(session.socket, message);
      }
    }
  }

  private send(socket: WebSocket, message: SignalMessage) {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      this.leave(socket);
    }
  }
}

function readJoinPayload(payload: unknown): JoinPayload {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const joinPayload = payload as JoinPayload;
  return {
    displayName: joinPayload.displayName?.trim(),
    password: joinPayload.password?.trim(),
  };
}

function toUserSummary(session: ClientSession): UserSummary {
  return {
    id: session.userId,
    displayName: session.displayName,
  };
}

function withCors(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
