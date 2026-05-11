# Mikcort Voice MVP

Lightweight desktop voice chat for small rooms. The Go backend is only a WebRTC signaling server; audio flows directly between desktop clients through peer-to-peer WebRTC connections.

## Stack

- Desktop UI: Tauri + Vue 3 + TypeScript
- Backend: Go standard library
- Transport: WebSocket signaling
- Voice: WebRTC mesh peer-to-peer
- STUN: `stun:stun.l.google.com:19302`
- No media server, TURN, database, auth, Docker, Kubernetes, or Redis

## Run Locally

Start the signaling server:

```powershell
go run ./cmd/server
```

The server listens on `:8080` by default. Override it with:

```powershell
$env:ADDR=":9090"; go run ./cmd/server
```

Install frontend dependencies:

```powershell
cmd /c npm install
```

Run the Tauri app in development:

```powershell
cmd /c npm run tauri dev
```

You can also run the web UI only for quick browser testing:

```powershell
cmd /c npm run dev
```

## Usage

1. Start the Go server.
2. Start two or more Tauri app instances.
3. Create a room in one instance.
4. Join the same room ID from the other instances.
5. Press **Start microphone** in each instance.
6. Use **Mute** / **Unmute** or **Leave** as needed.

## Checks

```powershell
go build ./...
cmd /c npm run typecheck
cmd /c npm run build
```

Tauri native builds also require the Rust toolchain and the platform-specific Tauri prerequisites.

## Docker Backend

Build and push the signaling server image:

```powershell
docker build -t mehmetcelenk/miccort:latest .
docker push mehmetcelenk/miccort:latest
```

Run it on a VM while publishing host port `8081`:

```bash
docker run -d --name miccort-signaling --restart unless-stopped -p 8081:8080 mehmetcelenk/miccort:latest
```

Desktop clients should then use:

```text
ws://SERVER_IP:8081/ws
```
