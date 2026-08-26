# Rasathane AI

Rasathane AI is a local-first Windows desktop MVP built with Electron, React, TypeScript, Vite, and SQLite. "Rasathane" means observatory: the app observes the desktop on demand, sends local context to a selected Ollama model, and returns step-by-step guidance.

V1 boundaries:

- guidance only
- no autonomous mouse control
- no autonomous keyboard control
- no terminal execution
- no file deletion
- no OS control
- no cloud AI providers
- no API keys

## What It Does

- lists installed local Ollama models
- lets you pick a local model
- stores settings, conversations, and observations in a local SQLite database
- captures the screen on demand with `Observe Screen`
- captures the screen and answers a question in one step with `Observe + Ask`
- queues the latest screenshot for the next chat turn
- sends screenshot context only to vision-capable local models by hint
- warns when a selected model appears text-only

## Install

```powershell
npm install
```

## Run In Development

```powershell
npm run dev
```

The dev flow starts Vite, compiles Electron TypeScript, and launches the desktop shell against the local renderer dev server.

## Build

```powershell
npm run build
```

## Build A Windows Installer

```powershell
npm run electron:build
```

Artifacts land under:

- `release-builds\win-unpacked\`
- `release-builds\Rasathane AI Setup 0.1.0.exe`

## Public Repository Notes

This repository is intended to contain source code and public documentation only. Private reports, datasets, screenshots, logs, databases, downloaded model binaries, and local role configs are excluded by `.gitignore`.

Useful public docs:

- `PUBLIC_RELEASE_NOTES.md`
- `docs/SECURITY_AND_PRIVACY.md`
- `docs/GITHUB_PUBLISHING_CHECKLIST.md`
- `config/rasathane_local_ai_team.roles.example.json`

## Smoke Test

```powershell
npm run smoke
```

## Ollama Setup

Install Ollama from:

- [https://ollama.com/download](https://ollama.com/download)

Start Ollama locally, then pull at least one model.

Examples:

```powershell
ollama pull gpt-oss:20b
ollama pull phi4:14b
ollama pull devstral:latest
```

For screenshot analysis, use a local vision-capable Ollama model that you trust and have tested on your own machine. Rasathane does not require cloud-hosted vision APIs.

```powershell
ollama pull llama3.2-vision:11b
```

## Example Supported Models

Text-focused local models:

- `gpt-oss:20b`
- `phi4:14b`
- `devstral:latest`
- `granite-code:8b`

Vision-capable examples by hint:

- `llama3.2-vision:11b`
- any local Ollama vision model you explicitly trust and validate

## Project Structure

- `src/main` - Electron main process and window bootstrapping
- `src/preload` - secure preload bridge
- `src/renderer` - React UI
- `src/shared` - shared TypeScript contracts
- `src/services/ollama` - local Ollama client
- `src/services/screen` - user-triggered screen capture
- `src/services/memory` - local SQLite persistence
- `src/services/settings` - default settings

## Notes

- screenshot files are stored under the Electron user data path only when privacy mode is off
- privacy mode keeps screen capture ephemeral for the next message only
- the app currently uses non-streaming chat for reliability
- private reports, datasets, model logs, screenshots, and local role configs should not be committed to public source control
