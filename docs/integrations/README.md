# Integrations

v0 scope is intentionally narrow:
- **Codex only**
- **`codex app-server` only** (structured interface + streaming)

Rootgrid treats Codex as an external “engine” and focuses on:
- starting/stopping sessions
- streaming events to the web UI
- extracting a reliable patch/diff artifact

See:
- `docs/integrations/codex.md`
