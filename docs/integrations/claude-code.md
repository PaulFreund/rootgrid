# Claude Code integration

> Out of scope for the current plan: Rootgrid v0 is **Codex-only** (via `codex app-server`). This doc is kept as historical reference from an earlier multi-agent plan.

Goal: integrate with Claude Code (the official agent tool) while preserving its own workflow loop, and expose the session as a Rootgrid-managed run with full streaming logs and patch review/apply.

## Option A — Claude Code CLI via PTY (recommended)

### What this enables
- Reuse the user’s existing Claude Code installation + auth.
- Preserve Claude Code’s native behavior (planning/execution, tool usage, patch generation).
- Full duplex I/O:
  - send follow-up prompts into the same session
  - stream/capture *all* output for UI + audit
  - cancel/stop reliably via signals/keystrokes

### Adapter responsibilities
- Spawn the CLI inside the project directory using a PTY.
- Normalize the terminal stream into events:
  - `stdout`-like text for UI
  - raw/ANSI log for storage + exact replay
- Extract artifacts:
  - patches/diffs
  - command output (if the agent runs commands)
  - summaries

### Patch discipline
Even if Claude Code can “apply changes” itself, Rootgrid’s default should be:
1. agent proposes patch
2. Rootgrid shows diff
3. user approves
4. Rootgrid applies + optionally runs verification

That keeps the safety model consistent across tools.

## Option B — CLI with structured events (when available)

If Claude Code supports a structured output mode, prefer it for:
- explicit tool-call visibility
- reliable patch boundaries
- robust “turn completed” detection

Still keep raw PTY logs as the source of truth for replay and debugging.

## Local transcript / history files (Claude Code-managed)

Claude Code stores conversation history locally (and supports resuming). The current on-disk shape is useful for Rootgrid display/debugging, but should be treated as an implementation detail.

Known locations (Linux/macOS paths shown):
- `~/.claude/history.jsonl` (user prompt history)
- `~/.claude/session-registry/*.json` (session metadata)
- `~/.claude/projects/<PROJECT>/<SESSION_ID>.jsonl` (per-session transcript; may be missing in some versions/bugs)
- `~/.claude/projects/<PROJECT>/<SESSION_ID>/subagents/*.jsonl` (subagent transcripts)

How Rootgrid can use this:
- Keep PTY capture as the ground-truth “all output” stream.
- When available, parse the JSONL transcript(s) to render a structured conversation view and associate tool/subagent output.

### Tracking active sessions + triggers via Claude files
What’s feasible today (best-effort; formats may evolve):

- **Active conversation detection**
  - `~/.claude/history.jsonl` appears append-only and includes `sessionId` + `project` per entry (example from user reports: `{"display":"…","timestamp":<ms>,"project":"…","sessionId":"…"}`).
  - New lines are a reliable trigger that “the user just sent something” in a given session.

- **Live transcript display**
  - Per-session transcripts under `~/.claude/projects/<PROJECT>/<SESSION_ID>.jsonl` are JSONL and can be tailed to display the conversation incrementally (including tool/subagent activity when present).

- **Session lifecycle signals**
  - `~/.claude/session-registry/*.json` can be watched for new/updated session metadata (including `transcript_path` when present).

Caveats:
- There are known bugs/versions where the main session transcript JSONL is not written even though `transcript_path` is set; Rootgrid should treat these files as optional enhancements, not the only source of truth.

## Matching Claude history to a Rootgrid session (no text comparison)

You can correlate Claude’s on-disk history/transcripts to an open Rootgrid session without comparing prompt/response text:
- Rootgrid should store the Claude `sessionId` (UUID) and the project root path.
- Per-session transcripts are keyed by `sessionId` (file name): `~/.claude/projects/<PROJECT>/<SESSION_ID>.jsonl`.
- Global prompt history entries in `~/.claude/history.jsonl` include `sessionId` and `project`, so you can filter by `sessionId`.

How to learn `sessionId` for a newly-started session (best-effort):
- Watch the per-project directory under `~/.claude/projects/` for a new `*.jsonl` file created after the Claude process starts; the filename is the `sessionId`.
- Alternatively, watch `~/.claude/session-registry/*.json` for a newly-created/updated session metadata record.

## VS Code extension interaction (`anthropic.claude-code`)

Claude Code has an official VS Code extension. The Claude docs explicitly state that the **extension and CLI share the same conversation history**, so Rootgrid can treat the on-disk `~/.claude/…` store as shared regardless of whether the user drove Claude from the CLI or VS Code.

Implications for Rootgrid:
- Rootgrid still cannot “scrape” another extension’s webview UI for output.
- If you need “all output”, keep the CLI/PTy integration (Option A).
- If you need structured history/session state, parse/tail the shared JSONL files under `~/.claude/…` (best-effort; formats may evolve).

## What “full integration” must include (Claude Code-specific)
- Cancellation semantics (SIGINT vs tool-specific commands) mapped to “Cancel run”.
- Workspace trust/policy gating before allowing command execution.
- Diff extraction that works even when output is richly formatted.

## References
- Claude Code docs (workflows / session history): https://code.claude.com/docs/en/common-workflows
- Claude Code VS Code extension (shared history + settings): https://code.claude.com/docs/en/vs-code
- Implementation notes (paths may change): https://github.com/anthropics/claude-code/issues/20612
- Example history JSONL entry + resume behavior: https://github.com/anthropics/claude-code/issues/19995
