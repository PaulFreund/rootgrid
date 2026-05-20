# Gemini integration

> Out of scope for the current plan: Rootgrid v0 is **Codex-only** (via `codex app-server`). This doc is kept as historical reference from an earlier multi-agent plan.

Goal: integrate with Gemini-based coding tooling while keeping the **official Gemini loop** as the “engine”, and exposing it through Rootgrid’s session/run model (streaming logs + patch review/apply).

Gemini tooling can exist in multiple “official” forms depending on product packaging (CLI, VS Code extension, SDK/API). Rootgrid should prefer the highest-fidelity option that still preserves the vendor tool’s own behavior.

## Option A — Gemini CLI via PTY (preferred when available)

If there is an official Gemini CLI/agent tool that can run in a terminal:
- Spawn it in a PTY from `rootgrid`
- Stream/capture full terminal output (raw + normalized)
- Send new prompts into the same running session
- Cancel/stop via signals/keystrokes

This gives the cleanest “native loop” integration without needing to reimplement anything.

## Local sessions / history files (Gemini CLI-managed)

Gemini CLI stores sessions on disk per project, including the full conversation history and metadata (prompts, responses, tool executions, token usage).

Known locations (Linux/macOS paths shown):
- Sessions: `~/.gemini/tmp/<project_hash>/chats/` (where `<project_hash>` is a SHA-256 hash of the project root path)
- Checkpoints (if enabled): `~/.gemini/tmp/<project_hash>/checkpoints` (conversation + tool calls saved in a JSON file)
- Snapshot history: `~/.gemini/history/<project_hash>` (git-based snapshots for checkpointing)

How Rootgrid can use this:
- PTY capture remains the “all output” stream.
- Session chat data is stored as **JSON files** (rewritten on update). Rootgrid can watch file changes and re-read to render a structured transcript (messages, tool calls, token usage, thoughts).
- Prefer asking the CLI to export/share a chat to JSON for stable parsing when you need a portable artifact (e.g. `/chat share file.json`).
- For isolation (and to avoid mixing with the user’s existing Gemini state), run Gemini CLI with `GEMINI_CLI_HOME` set to the Rootgrid session directory.

### Tracking active sessions + triggers via Gemini files
- **Active conversation detection**: watch the current session JSON file and use its `lastUpdated` + message ids to compute deltas.
- **Turn/tool triggers**: Gemini’s stored message records include assistant messages with `toolCalls`, token usage, and (when available) thoughts/reasoning summaries — this is usually easier than parsing terminal UI for structured events.

## Matching Gemini history to a Rootgrid session (no text comparison)

You can correlate Gemini’s on-disk chat store to an open Rootgrid session without comparing prompt/response text:
- **Best**: run Gemini CLI with a per-session `GEMINI_CLI_HOME` (Rootgrid session dir). Then the `tmp/<project_hash>/…` tree belongs to that Rootgrid session.
- Gemini’s store is partitioned by **project hash** (`<project_hash>` is SHA-256 of the project root path), so Rootgrid can compute it and locate the right folder deterministically.
- To pick the specific chat for this session without text matching, track which `chats/*.json` file is created/updated by the supervised Gemini process (filesystem events / mtime) and store that file path (or its `id` if you parse metadata).

## Option B — CLI with structured events (ideal, when available)

If the Gemini tool supports a structured mode (JSONL events, explicit diff markers):
- Parse events into Rootgrid’s event model
- Keep raw PTY logs as a fallback + for replay

## VS Code extensions (how they relate to Gemini CLI history)

There are multiple “Gemini in VS Code” surfaces. For Rootgrid, the key question is whether the VS Code experience is just a **front-end to Gemini CLI** (shared history) or a separate product (separate history).

### Gemini CLI Companion (`google.gemini-cli-vscode-ide-companion`)
The Gemini CLI Companion extension is designed to connect to a running Gemini CLI session (IDE companion). In this setup:
- Gemini CLI remains the engine.
- The on-disk session store under `GEMINI_CLI_HOME` is still the source of truth, so the VS Code view and CLI share history.

### Gemini Code Assist (agent mode)
Google documents that Gemini Code Assist agent mode in VS Code is powered by Gemini CLI, but it is still a separate VS Code product/UX surface.

Rootgrid guidance:
- Assume Gemini Code Assist chat history is separate unless proven otherwise (don’t rely on it writing the same `~/.gemini/tmp/<project_hash>/chats/…` files).
- If you need full output capture and deterministic history access, integrate directly with Gemini CLI (Option A + local session JSON) rather than trying to bridge a VS Code UI.

## Option D — Direct API/SDK (fallback; may not preserve the “original loop”)

If neither a usable CLI nor an extension API exists, an API/SDK integration may still be valuable, but it changes the integration category:
- Rootgrid becomes responsible for the “loop” (prompting, tool policies, patch formatting), which may diverge from the vendor tool’s behavior.

If the project requirement is strictly “use the original loop”, treat this option as a last resort until an official CLI/SDK for the agent loop is available.

## What “full integration” must include (Gemini-specific)
- A deterministic patch format contract (unified diff preferred).
- Clear separation of “model response” vs “tool output” vs “patch artifact”.
- Credential handling through the vendor’s supported auth mechanism (Rootgrid should not ask users to copy/paste secrets into Rootgrid).

## References
- Gemini CLI session management: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/session-management.md
- Gemini CLI checkpointing: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/checkpointing.md
- Gemini CLI commands (incl. `/chat share`): https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/commands.md
- Gemini CLI IDE integration (companion extension): https://google-gemini.github.io/gemini-cli/docs/ide-integration/
- IDE companion protocol spec (MCP over HTTP): https://geminicli.com/docs/ide-integration/ide-companion-spec/
- Gemini Code Assist agent mode powered by Gemini CLI: https://developers.google.com/gemini-code-assist/docs/gemini-cli
