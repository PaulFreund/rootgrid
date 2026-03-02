# OpenCode integration

> Out of scope for the current plan: Rootgrid v0 is **Codex-only** (via `codex app-server`). This doc is kept as historical reference from an earlier multi-agent plan.

Goal: integrate with OpenCode (`opencode`) while preserving OpenCode’s own loop, and expose it through Rootgrid (`rootgrid` supervision + Rootgrid UI for streaming logs and patch review/apply).

OpenCode is client/server: a local OpenCode server owns sessions and streams events; the TUI, SDK, and IDE plugins are clients. This makes the server API the most reliable “native loop” integration point.

## Option A — OpenCode server API + SSE (recommended)

Run `opencode serve` as the supervised session process and integrate over HTTP:
- Use the server’s OpenAPI endpoints to create/list sessions, send prompts, and fetch messages/artifacts.
- Subscribe to the server’s Server-Sent Events (SSE) stream for incremental output, tool-call events, and turn boundaries.

Why prefer this:
- Duplex integration without PTY heuristics.
- Clear, structured events (better than parsing terminal UI).
- Matches how the IDE plugin and SDK interact with OpenCode.

## Option B — OpenCode TUI via PTY (for “all output” fidelity)

If you need to capture the exact terminal UI (spinners, progress UI, ANSI), run the TUI in a PTY:
- PTY capture becomes the canonical “all output” log.
- Optionally still use the server API/SSE as a structured secondary stream for transcripts + triggers.

## VS Code extension interaction (`sst-dev.opencode`)

OpenCode has an official VS Code extension. It is an IDE client of the same local OpenCode server (the server exposes a `/tui` endpoint specifically for IDE plugins), so:
- sessions are shared between the TUI/CLI and VS Code
- “history” is shared because the server + local project store is shared

Rootgrid implication: don’t try to bridge/scrape the VS Code UI; integrate at the server layer (Option A) or supervise the TUI in a PTY (Option B).

## Local storage / history (OpenCode-managed)

OpenCode stores state under `~/.local/share/opencode/`:
- `state.json`, `config.json`, `auth.json`
- project data under `project/<project-slug>/…` (including `storage/` for session/message data)

Rootgrid guidance:
- Prefer the server API + SSE for stable history/session tracking.
- Treat on-disk files as implementation details; at most, watch `project/<slug>/storage/` for change as a best-effort “something happened” signal.

## Matching OpenCode history to a Rootgrid session (no text comparison)

If Rootgrid integrates via the server (Option A), correlation is deterministic:
- Store the OpenCode `sessionID` returned by the server when the session is created/selected.
- Use server APIs and SSE events keyed by that `sessionID` to fetch history and stream updates.

Avoid trying to reverse-engineer the `project/<slug>/storage/` files; treat them as private implementation details.

## References
- OpenCode server (OpenAPI + SSE events): https://dev.opencode.ai/docs/server/
- OpenCode IDE integration: https://opencode.ai/docs/ide/
- OpenCode storage paths / troubleshooting: https://dev.opencode.ai/docs/troubleshooting/
- OpenCode VS Code extension: https://marketplace.visualstudio.com/items?itemName=sst-dev.opencode
