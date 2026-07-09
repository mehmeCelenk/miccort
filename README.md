# Mikcort Voice

Lightweight desktop voice chat for small rooms. The Go and Cloudflare backends are signaling-only; audio, screen share, and voice data flow directly between clients through peer-to-peer WebRTC.

## Project Structure

```text
mikcort/
  frontend/                    Vue 3 + Tauri desktop app
    src/                       Frontend source
    src-tauri/                 Native desktop shell
  backend/
    go/                        Self-hosted Go signaling server
      cmd/server/
      internal/
    cloudflare-signaling/      Cloudflare Workers + Durable Objects signaling server
```

## Stack

- Desktop UI: Tauri + Vue 3 + TypeScript
- Backend option 1: Go standard library WebSocket signaling
- Backend option 2: Cloudflare Workers + Durable Objects
- Voice: WebRTC mesh peer-to-peer
- STUN: `stun:stun.l.google.com:19302`, `stun:global.stun.twilio.com:3478`
- No media server, database, auth, Kubernetes, or Redis

## Run Locally

Start the Go signaling server:

```powershell
cd backend/go
go run ./cmd/server
```

The server listens on `:8080` by default. Override it with:

```powershell
cd backend/go
$env:ADDR=":9090"; go run ./cmd/server
```

Install frontend dependencies:

```powershell
cd frontend
cmd /c npm install
```

Run the Tauri app in development:

```powershell
cd frontend
cmd /c npm run tauri dev
```

You can also run the web UI only for quick browser testing:

```powershell
cd frontend
cmd /c npm run dev
```

## Usage

1. Start one signaling backend.
2. Start two or more app instances.
3. Create a room in one instance.
4. Join the same room ID from the other instances.
5. Optional: set a room password to hide the room's users in the public room list.
6. Press **Start microphone** in each instance.

## Checks

```powershell
cd backend/go
go test ./...
go build ./...
```

```powershell
cd frontend
cmd /c npm run build
```

```powershell
cd backend/cloudflare-signaling
cmd /c npm run typecheck
```

Tauri native builds also require the Rust toolchain and the platform-specific Tauri prerequisites.

## Desktop Auto Updates

The Tauri desktop app uses the official Tauri updater plugin and GitHub Releases.

Updater endpoint:

```text
https://github.com/mehmeCelenk/miccort/releases/latest/download/latest.json
```

The app checks for updates on startup. If an update exists, it downloads and installs it automatically, then asks the user to restart.

### Signing Keys

Updates are signed. The public key is stored in `frontend/src-tauri/tauri.conf.json`. The private key must stay secret and is ignored by Git under `frontend/.tauri/`.

Generate a new keypair only if you are starting a new update channel:

```powershell
cd frontend
cmd /c npm run tauri signer generate -- --ci -f -w .tauri\mikcort-updater.key
```

Use the generated public key in `frontend/src-tauri/tauri.conf.json`.

Add these GitHub repository secrets:

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

If the key was generated with `--ci` and no password, set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to an empty string or omit it.

### Releasing A New Version

Use semantic versioning, for example `0.2.0`.

1. Update the version in:
   - `frontend/package.json`
   - `frontend/src-tauri/Cargo.toml`
   - `frontend/src-tauri/tauri.conf.json`
2. Commit the version bump.
3. Create and push a matching tag:

```powershell
git tag v0.2.0
git push origin main v0.2.0
```

The `Release desktop app` workflow builds the Windows app and a universal macOS desktop app, signs updater artifacts, creates a GitHub Release, and uploads `latest.json`.

## Docker Backend

Build and push the Go signaling server image:

```powershell
docker build -t mehmetcelenk/miccort:latest backend/go
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

## Cloudflare Workers Backend

An alternative signaling backend lives in `backend/cloudflare-signaling/`. It uses Cloudflare Workers + Durable Objects and keeps the same WebSocket message contract as the Go backend.

```bash
cd backend/cloudflare-signaling
npm install
npm run deploy
```

Desktop clients can then use:

```text
wss://miccort-signaling.<your-subdomain>.workers.dev/ws
```

The Cloudflare backend is also signaling-only. WebRTC audio remains peer-to-peer.
