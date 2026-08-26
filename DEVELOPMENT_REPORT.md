# Rasathane AI Development Report

## Current Architecture

Rasathane AI is a Windows-first Electron shell with a React renderer and a secure preload bridge.

- `src/main/index.ts`
  - app lifecycle
  - IPC registration
  - local state for selected model and pending observation
- `src/main/window.ts`
  - BrowserWindow creation
  - secure preload path
  - dev-vs-built renderer loading
- `src/preload/index.ts`
  - typed `window.rasathane` bridge
- `src/renderer/App.tsx`
  - observatory-style UI
  - model selection
  - session/chat panel
  - observe flow
  - settings form
- `src/services/ollama/client.ts`
  - `/api/tags` model listing
  - `/api/chat` non-streaming chat
  - vision-capability hints
- `src/services/screen/capture.ts`
  - `desktopCapturer` screen capture
  - preview generation
  - optional local file persistence
- `src/services/memory/database.ts`
  - SQLite persistence using `sql.js`
  - settings
  - conversations
  - messages
  - observations

## What Works

- install completes cleanly
- typecheck passes
- production build passes
- Windows installer build passes
- local model listing works against the local Ollama server
- chat request wiring works against the local Ollama server
- clear missing-Ollama error is returned for an invalid local endpoint
- screen capture works through Electron
- settings, conversations, and messages persist to a local SQLite file
- smoke mode works for the development executable and the packaged Windows executable

## What Does Not Work Yet

- no streaming chat yet
- no voice input yet
- no hotkey trigger yet
- no automated GUI-click smoke suite
- no direct end-to-end UI automation proving every renderer interaction visually
- text-only vision-warning path is implemented but not exercised through a full renderer automation pass
- model capability detection is best-effort by name hint, not by a richer capability manifest
- no custom app icon yet

## Next Development Steps

1. Add a small Electron-driven UI smoke harness for settings, model selection, observe, and send flow.
2. Add streaming chat as an optional mode after keeping the current non-streaming path stable.
3. Improve model capability detection beyond name hints.
4. Add conversation selection/creation controls instead of using a single active session by default.
5. Add a proper app icon and polish the right-side panel visuals.
6. Add a bounded history strategy for long conversations.
