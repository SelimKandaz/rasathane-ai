# Public Release Notes

Rasathane AI is safe to publish as source code when private run artifacts are excluded.

Included:

- Electron, React, TypeScript, Vite, and SQLite application source
- local Ollama integration code
- screen observation UI and privacy controls
- local memory/storage implementation
- build and smoke-test scripts
- public documentation

Excluded from public release:

- `reports/`
- `datasets/`
- `release-builds/`
- `dist/`
- `dist-electron/`
- local logs
- `.env` files
- SQLite databases
- downloaded models and tool binaries
- private model-role proposals

Security posture:

- local-first by design
- no cloud AI provider required
- no API keys required
- no autonomous mouse, keyboard, terminal, or OS control
- screenshots are user-triggered
- privacy mode keeps screenshots ephemeral

