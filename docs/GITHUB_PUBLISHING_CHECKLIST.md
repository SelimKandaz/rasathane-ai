# GitHub Publishing Checklist

Use this checklist before making the repository public.

## Publish

- application source under `src/`
- `package.json`
- `package-lock.json`
- TypeScript and Vite config
- public README and docs
- sanitized example config files

## Do Not Publish

- `reports/`
- `datasets/`
- `release-builds/`
- `dist/`
- `dist-electron/`
- `node_modules/`
- `tools/downloads/`
- `tools/whisper.cpp/`
- private orchestration scripts under `tools/`
- `.env`
- local database files
- screenshots
- raw benchmark outputs
- private model-role proposals

## Final Local Checks

```powershell
git status --short
git ls-files
npm run typecheck
```

Review the staged file list before pushing.
