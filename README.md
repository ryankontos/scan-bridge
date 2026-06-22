# Scan Bridge

Scan text on an iPhone, OCR it on this Mac, and push the result to a paired desktop browser over WebSocket.

## What This Repo Contains

- Desktop receiver UI
- Phone scanner UI
- Node server with WebSocket session pairing
- Server-side OCR using `tesseract`
- LaunchAgent-based background service setup for this Mac
- AppleScript clipboard observer for Chrome

Important files:

- App source: [src/App.tsx](/Users/ryan/Documents/New project/scan-bridge/src/App.tsx)
- Server: [server/index.ts](/Users/ryan/Documents/New project/scan-bridge/server/index.ts)
- OCR pipeline: [server/ocr.ts](/Users/ryan/Documents/New project/scan-bridge/server/ocr.ts)
- AppleScript: [applescripts/scan_bridge_clipboard_observer.applescript](/Users/ryan/Documents/New project/scan-bridge/applescripts/scan_bridge_clipboard_observer.applescript)
- Service runner: [run-service.sh](/Users/ryan/Documents/New project/scan-bridge/run-service.sh)
- Service deploy script: [scripts/deploy-service.sh](/Users/ryan/Documents/New project/scan-bridge/scripts/deploy-service.sh)

## Requirements

- Node 22+
- npm
- Homebrew
- `tesseract`
- `cloudflared`
- Google Chrome if using the AppleScript observer

Install OCR:

```bash
brew install tesseract
```

This project is tuned around the default Homebrew Tesseract package with `eng`, `osd`, and `snum`.

## Local Development

Install dependencies:

```bash
npm install
```

Run the app in dev mode:

```bash
npm run dev
```

That starts:

- Vite frontend on `http://localhost:5173`
- API/WebSocket server on `http://localhost:8787`

## One-Off Production Run

Build:

```bash
npm run build
```

Start:

```bash
npm run start
```

Stop it with `Ctrl+C`.

## Persistent Background Service

This Mac runs the persistent service from:

```bash
~/Services/scan-bridge
```

The LaunchAgent is:

```bash
~/Library/LaunchAgents/com.ryankontos.scan-bridge.plist
```

### Check status

```bash
launchctl print gui/$(id -u)/com.ryankontos.scan-bridge
```

### Start or restart the service

```bash
launchctl kickstart -k gui/$(id -u)/com.ryankontos.scan-bridge
```

### Stop the service

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ryankontos.scan-bridge.plist
```

### Start it again after a stop

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ryankontos.scan-bridge.plist
launchctl kickstart -k gui/$(id -u)/com.ryankontos.scan-bridge
```

### Logs

```bash
tail -f ~/Library/Logs/scan-bridge.log
tail -f ~/Library/Logs/scan-bridge-error.log
```

## How To Deploy Code Changes To The Running Service

From this repo:

```bash
./scripts/deploy-service.sh
```

That script:

1. builds the app
2. syncs this repo into `~/Services/scan-bridge`
3. runs `npm ci` in the service copy
4. restarts the LaunchAgent

If the service stops working after a deploy, check:

```bash
tail -n 100 ~/Library/Logs/scan-bridge-error.log
launchctl print gui/$(id -u)/com.ryankontos.scan-bridge
```

## Tunnel / Public Hostname

The site is exposed through Cloudflare Tunnel at:

```bash
https://scan.ryankontos.com
```

Tunnel config used on this Mac:

```bash
~/.cloudflared/departures.yml
```

Relevant ingress entry:

```yml
- hostname: scan.ryankontos.com
  service: http://127.0.0.1:8787
```

Start or restart the tunnel manually:

```bash
cloudflared tunnel --config ~/.cloudflared/departures.yml run departures
```

## Quick Health Checks

Local:

```bash
curl http://localhost:8787/api/health
```

Public:

```bash
curl https://scan.ryankontos.com/api/health
```

Expected response:

```json
{"ok":true}
```

## AppleScript Observer

The AppleScript file is included in the repo here:

```bash
applescripts/scan_bridge_clipboard_observer.applescript
```

What it does:

- uses Google Chrome
- watches the desktop page
- reads the latest regex result
- copies new matches to the clipboard

Compile it manually if needed:

```bash
osacompile -o ~/Desktop/scan-bridge-observer.scpt applescripts/scan_bridge_clipboard_observer.applescript
```

Run it manually:

```bash
osascript applescripts/scan_bridge_clipboard_observer.applescript
```

If testing locally instead of the public hostname, edit:

```applescript
property targetUrlPrefix : "https://scan.ryankontos.com/"
```

to:

```applescript
property targetUrlPrefix : "http://localhost:5173/"
```

## Useful Paths

Repo source:

```bash
/Users/ryan/Documents/New project/scan-bridge
```

Live service copy:

```bash
~/Services/scan-bridge
```

LaunchAgent:

```bash
~/Library/LaunchAgents/com.ryankontos.scan-bridge.plist
```

## Validation Commands

```bash
npm run build
npm run lint
curl http://localhost:8787/api/health
curl https://scan.ryankontos.com/api/health
```
