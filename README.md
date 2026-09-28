# Rasathane AI

A local desktop assistant that looks at your screen when you ask and gives step-by-step guidance using a local Ollama model. "Rasathane" means observatory in Turkish.

Everything stays on your machine. No cloud AI and no API keys. It only gives guidance: it does not move the mouse, type, run commands, or delete files.

## Features

- Works with any installed Ollama model
- `Observe Screen` and `Observe + Ask` for on-demand screenshots
- Local SQLite storage for settings, chats, and observations
- Privacy mode that keeps a screenshot only for the next message

## Run

```powershell
npm install
npm run dev
```

Build a Windows installer with `npm run electron:build`.

For screen reading, pull a vision-capable model, for example:

```powershell
ollama pull llama3.2-vision:11b
```

Built with Electron, React, TypeScript, Vite, and SQLite.
