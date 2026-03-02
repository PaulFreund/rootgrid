# Copilot CLI integration

> Out of scope for the current plan: Rootgrid v0 is **Codex-only** (via `codex app-server`). This doc is kept as historical reference from an earlier multi-agent plan.

Goal: integrate with **GitHub Copilot CLI** while preserving its native “agent loop” and still providing Rootgrid’s core UX (session management, streaming logs, patch review/apply).

> Note: “GitHub Copilot in the CLI” (the `gh copilot …` GitHub CLI extension) was deprecated on **October 25, 2025** in favor of the newer **Copilot CLI** (`copilot`) which is an agentic assistant with interactive sessions.

## Option A — `copilot` interactive mode via PTY (recommended)

### Why this is the default
- Preserves Copilot CLI’s native workflow loop (approvals, tool usage, diffs, etc.).
- Works well with Rootgrid supervision: start session, send follow-ups, stream output, cancel/stop.

### What `rootgrid` does
- Spawn `copilot` in the project working directory using a PTY.
- Record the raw terminal stream (ANSI + cursor control) for faithful replay.
- Normalize output into Rootgrid events for UI display/search.

## Option B — programmatic mode (single prompt)

Copilot CLI supports a one-shot prompt mode (e.g. `copilot -p "…"`) which can be useful for:
- “run this once” tasks
- building a non-interactive pipeline

Tradeoff: it’s simpler to automate, but you must decide how to map Copilot’s tool approvals into Rootgrid’s approval model.

## Local sessions / history files (Copilot CLI-managed)

Copilot CLI persists config and session state on disk, which Rootgrid can use as a **secondary structured source** for transcript/session views (while keeping PTY logs as the “all output” truth).

Known locations (Linux/macOS paths shown):
- Config directory: `~/.copilot/` by default (can be overridden via `--config-dir`; some config files also respect `XDG_CONFIG_HOME`)
- Session store (current): `~/.copilot/session-state/`
- Session store (legacy): `~/.copilot/history-session-state/` (migrated as sessions are resumed)
- MCP servers config: `~/.copilot/mcp-config.json`
- Custom agents: `~/.copilot/agents/`

How Rootgrid can use this:
- Prefer running Copilot CLI with `--config-dir` set to the Rootgrid session directory to isolate sessions by project/run.
- Use `/share` (or non-interactive sharing flags) to export a session to a stable artifact (e.g. Markdown) for display/audit.
- Treat on-disk session-state formats as implementation details (preview software); rely on them only as best-effort enhancements.

### Tracking active sessions + triggers via Copilot CLI files
This is feasible but should be treated as best-effort because formats may change:
- Copilot CLI stores per-session state under `~/.copilot/session-state/<session-id>/` (for example, user reports mention a `plan.md` file updated during agent workflows).
- Rootgrid can watch the active session directory for file changes and use those updates as triggers (plan updates, summaries, etc.).
- For a stable “conversation display”, prefer PTY capture and/or explicit exports (`/share`).

## Matching Copilot CLI history to a Rootgrid session (no text comparison)

You can correlate Copilot’s local session-state files to an open Rootgrid session without comparing prompt/response text:
- **Best**: run Copilot CLI with `--config-dir` set to the Rootgrid session directory, so the session-state belongs to that Rootgrid session.
- Store the `sessionId` implicitly as the `session-state/<session-id>/` directory name you observe being created/updated by the running Copilot process.
- Use that directory as the “active transcript/state” source (best-effort), and rely on PTY capture for a complete “all output” stream.

## VS Code extension interaction (Copilot Chat)

GitHub Copilot in VS Code (Copilot/Copilot Chat extensions) is a separate client UX from Copilot CLI. Rootgrid should treat them as **separate histories**:
- Copilot CLI stores session state under `~/.copilot/…`.
- VS Code extensions store their own state in VS Code extension storage (and may also keep history server-side).

Rootgrid implication: if you need “all output” capture and deterministic local transcript access, integrate with Copilot CLI (Option A) rather than trying to bridge the VS Code chat UI.

## What “full integration” must include (Copilot CLI-specific)
- Interactive session lifecycle (start, prompt, follow-up) mapped into Rootgrid sessions/runs.
- Full output capture (raw PTY bytes) + normalized events.
- A clear “cancel current action” vs “stop session” mapping (tool-specific).
- Artifact extraction strategy:
  - prefer explicit “diff view” + unified diff export when available, or
  - instruct Copilot to output a single unified diff bounded by markers.

## References
- About Copilot CLI (modes + security + config dir): https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli
- Deprecation of `gh copilot …` CLI extension: https://github.blog/changelog/2025-07-25-github-copilot-in-the-cli-is-being-deprecated/
- Deprecation effective date notice: https://github.blog/changelog/2025-10-25-github-copilot-in-the-cli-is-being-deprecated/
- Copilot CLI changelog (session-state paths, flags): https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md
- Example `session-state/<session-id>/plan.md` location: https://github.com/github/copilot-cli/issues/1111
