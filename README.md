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

## Desktop Auto Updates

The Tauri desktop app uses the official Tauri updater plugin and GitHub Releases.

Updater endpoint:

```text
https://github.com/mehmeCelenk/miccort/releases/latest/download/latest.json
```

The app checks for updates on startup. If an update exists, it downloads and installs it automatically, then asks the user to restart.

### Signing Keys

Updates are signed. The public key is stored in `src-tauri/tauri.conf.json`. The private key must stay secret and is ignored by Git under `.tauri/`.

Generate a new keypair only if you are starting a new update channel:

```powershell
cmd /c npm run tauri signer generate -- --ci -f -w .tauri\mikcort-updater.key
```

Use the generated public key in `src-tauri/tauri.conf.json`:

```json
{
  "plugins": {
    "updater": {
      "pubkey": "PUBLIC_KEY_CONTENT"
    }
  }
}
```

Add these GitHub repository secrets:

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

If the key was generated with `--ci` and no password, set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to an empty string or omit it.

### Releasing A New Version

Use semantic versioning, for example `0.2.0`.

1. Update the version in:
   - `package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`
2. Commit the version bump.
3. Create and push a matching tag:

```powershell
git tag v0.2.0
git push origin main v0.2.0
```

The `Release desktop app` workflow builds the Windows app, signs updater artifacts, creates a GitHub Release, and uploads `latest.json`.

Installed apps will check:

```text
https://github.com/mehmeCelenk/miccort/releases/latest/download/latest.json
```

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

## Cloudflare Workers Backend

An alternative signaling backend lives in `cloudflare-signaling/`. It uses Cloudflare Workers + Durable Objects and keeps the same WebSocket message contract as the Go backend.

```bash
cd cloudflare-signaling
npm install
npm run deploy
```

Desktop clients can then use:

```text
wss://miccort-signaling.<your-subdomain>.workers.dev/ws
```

The Cloudflare backend is also signaling-only. WebRTC audio remains peer-to-peer.
