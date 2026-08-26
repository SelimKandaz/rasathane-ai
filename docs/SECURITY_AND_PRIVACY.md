# Security and Privacy

Rasathane AI is designed as a local-first assistant shell for Windows.

## Default Boundaries

- No cloud AI calls are required.
- No API keys are required.
- No autonomous mouse control is provided.
- No autonomous keyboard control is provided.
- No terminal execution is provided.
- No file deletion is provided.
- No operating system control is provided.
- Screen observation is user-triggered.

## Local Data

Rasathane can store settings, conversations, and observations in local SQLite storage. Public releases should not include runtime databases, screenshots, reports, benchmark outputs, or datasets.

## Screenshot Handling

When privacy mode is enabled, screenshots are intended to be temporary context for the next model turn. When privacy mode is disabled, screenshots may be stored under the Electron user data path.

## Model Use

Rasathane uses locally installed Ollama models. Model choice is controlled by the user. Public source releases should avoid including private model-role configs, raw model logs, or benchmark artifacts.

## Safe Publishing Checklist

Before pushing to a public repository:

- confirm `.env` files are excluded
- confirm SQLite/database files are excluded
- confirm `reports/` is excluded
- confirm `datasets/` is excluded
- confirm build artifacts are excluded
- confirm downloaded model/tool binaries are excluded
- confirm private local role configs are excluded

