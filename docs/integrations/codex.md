# Codex integration

Goal: integrate with Codex while preserving Codex’s own agent loop, and still provide Rootgrid’s core UX (session management, streaming logs, patch review/apply) through the **web UI**.

v0 scope: **Codex `app-server` only**.

## Codex `app-server` (v0)

Codex exposes a first-party structured interface (`codex app-server`) used by rich clients (including the Codex VS Code extension). It provides:
- JSON-RPC over stdio (requests/responses)
- streaming output as JSON-RPC notifications (incremental deltas/events)
- explicit thread/turn primitives for driving/resuming conversations

### Why this is the default (v0)
- Uses the user’s existing Codex installation + auth/subscription.
- Keeps Codex as the “engine” while giving Rootgrid a structured, duplex control surface.
- Makes turn boundaries + tool activity far more reliable than parsing an interactive terminal UI.

### What `rootgrid` does
- Spawn `codex app-server` as the supervised session process (not a PTY).
- Drive conversations via JSON-RPC:
  - create/resume a thread
  - send user prompts/follow-ups
  - cancel/stop when requested
- Read JSON-RPC notifications (streaming deltas + events) and map them to Rootgrid’s event model (messages, tool calls, turn boundaries, artifacts).
- Persist:
  - a structured event stream (`events.jsonl`) for UI rendering
  - raw process stdout/stderr for debugging

### Making patch output reliable
Prefer structured patch/diff artifacts if Codex emits them in the JSON-RPC event stream. Otherwise:
- enforce a patch contract via session instructions
- request a **single unified diff** as an explicit artifact

### Cancellation / stop
Support both:
- **Cancel current turn** via the structured control surface (preferred) and fall back to terminating the process if needed.
- **Stop session**: terminate the process and mark the session exited; keep logs/artifacts.

## Attachments / multimodal input (v0)

Rootgrid supports user file attachments in the web UI (especially images).

Codex `app-server` supports sending a turn as an **input array** (`UserInput[]`) instead of a single string prompt.
Rootgrid uses this to support images:

- Text: `{ type: "text", text: "..." }`
- Image (local file on the runner): `{ type: "localImage", path: "/abs/path/on/runner.png" }`

Implementation notes (Rootgrid v0):
- The browser uploads attachment bytes to the host (base64-in-JSON in v0).
- Attachment size limit (v0): max **50MB** per file.
- The host stores attachments on disk (`~/.rootgrid/uploads/<sessionId>/...`) so the UI can download/preview them later.
- The host also forwards attachments to the runner (via `session.upload`) and receives a runner-local path.
- When starting/sending a turn, the host builds `input: UserInput[]` containing:
  - one `text` item (the user’s message; if empty, a placeholder like `"(see attachments)"`)
  - one `localImage` item per image attachment
- Non-image files are not currently sent as structured app-server inputs; Rootgrid appends a small
  `[Uploaded files]` block listing runner-local file paths into the text prompt so tools can reference them.

## Approvals + sandbox (Codex-managed)

Rootgrid should behave like the native Codex CLI:

- The user selects an **approval policy** and **sandbox policy** for a session.
- Rootgrid passes these into `codex app-server` (thread/start + turn/start params).
- Rootgrid can also update these during an active session by applying new overrides on the next `turn/start` (Codex treats per-turn overrides as the defaults for subsequent turns).
- Codex decides *when* to ask for approval and emits approval requests only when needed.

When Codex needs approval, the app-server sends JSON-RPC **requests** such as:
- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`

Rootgrid must:
1) display the request in the web UI (command/file change + reason)
2) return the user decision back to Codex app-server (`accept`, `acceptForSession`, `decline`, `cancel`)

Rootgrid must **not** add an extra “apply patch” gate on top of Codex for v0; Codex remains the owner of:
- command execution
- file changes / patch application

### Local transcript / history files (Codex-managed)
Codex can persist session transcripts to a local JSONL history file:
- State dir: `CODEX_HOME` (default: `~/.codex/`)
- Config: `CODEX_HOME/config.toml`
- Transcript log: `CODEX_HOME/history.jsonl` (controlled by `history.persistence`; size bounded by `history.max_bytes`)

How Rootgrid can use this:
- Prefer storing the **structured JSON-RPC event stream** (canonical for v0) for rendering and triggers.
- Additionally, **tail/parse `history.jsonl`** for a structured “chat transcript” view when useful (optional).
- **Default (v0):** run Codex with the user’s normal `CODEX_HOME` so:
  - the user’s Codex settings apply
  - native Codex can resume the same sessions/threads
- Rootgrid retention (`retentionDays`) applies to **Rootgrid’s DB/artifacts only**; Rootgrid does not prune Codex history.
- (Optional, later): support a “session-isolated `CODEX_HOME`” mode for determinism/testing.

### Tracking active sessions + triggers via Codex files
Codex stores *two* useful on-disk streams that Rootgrid can watch:

1) **Global message history** (`CODEX_HOME/history.jsonl`)
- Format: JSONL (one JSON object per line) with a session/thread id + timestamp + text (e.g. `{"session_id":"<thread_id>","ts":<unix_seconds>,"text":"..."}`; older files may use `conversation_id`).
- Write pattern: append-only; safe to tail for incremental updates.
- Good for: listing/reconstructing a “chat transcript” view across sessions.

2) **Per-session rollouts** (`CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`)
- Format: JSONL of structured session events (session meta + response items + tool events).
- Write pattern: appended/flushed after updates; suitable for a live event stream.
- Good for: “what happened when” timelines, tool-call visibility, and more reliable “turn completed” detection than parsing terminal UI.

Recommended approach:
- Treat the app-server JSON-RPC event stream as canonical (v0).
- Use rollout JSONL as a secondary structured source for triggers like:
  - new assistant message chunks / end-of-turn
  - tool call started/finished
  - compaction events
  - session metadata (cwd, model, etc.)

### Matching Codex history to a Rootgrid session (no text comparison)
You can correlate on-disk history to the Rootgrid session without comparing prompt/response text:
- Always store the Codex **thread id**:
  - `codex app-server`: thread ids are explicit (e.g. `thr_…`) in the JSON-RPC/API and appear in the event stream.
- If you choose to display Codex-managed history (`CODEX_HOME/history.jsonl`) in the UI:
  - filter by `session_id`/`thread_id` instead of text matching
- (Optional, later) if Rootgrid supports a per-session `CODEX_HOME` mode, correlation becomes trivial because every file under that `CODEX_HOME` belongs to one Rootgrid session.

## Non-goals for v0

- Driving the interactive Codex CLI via PTY.
- Integrating via the Codex VS Code extension.

## What “full integration” must include (Codex-specific)
- Session persistence across turns (keep a process alive, or use the tool’s own session store).
- Streaming events + artifacts in real time (messages, tool calls, state transitions).
- Deterministic patch extraction (unified diff preferred).
- Clear turn boundaries (prompt-ready detection per tool).

## References
- Codex `app-server` (protocol + streaming): https://developers.openai.com/codex/app-server
- Codex IDE extension: https://developers.openai.com/codex/ide
- Codex CLI advanced configuration: https://developers.openai.com/codex/config-advanced
- Codex CLI config reference (incl. `history.persistence`): https://developers.openai.com/codex/config-reference
