# Cloudflare Signaling Backend

Alternative signaling backend for Miccort using Cloudflare Workers + Durable Objects.

The Go backend remains unchanged. This Worker only forwards WebRTC signaling messages. Audio still flows directly between clients using WebRTC P2P.

## Message Contract

The Worker accepts the same WebSocket message format as the Go backend:

```json
{
  "type": "join-room | user-joined | user-left | offer | answer | ice-candidate | room-users | error",
  "roomId": "string",
  "userId": "string",
  "targetUserId": "string",
  "payload": {}
}
```

## Local Dev

```bash
npm install
npm run dev
```

Use the local Worker WebSocket URL in the desktop app:

```text
ws://localhost:8787/ws
```

## Deploy

Login once:

```bash
npx wrangler login
```

Deploy:

```bash
npm run deploy
```

Then use the deployed Worker URL in the desktop app:

```text
wss://miccort-signaling.<your-subdomain>.workers.dev/ws
```

## Notes

- Durable Objects keep room state and connected WebSocket sessions.
- The Worker does not relay audio, video, or screen share media.
- STUN/TURN behavior remains controlled by the desktop WebRTC client.
