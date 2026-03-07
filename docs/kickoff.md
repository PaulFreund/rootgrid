# Implementation baseline (v0)

This document records the **v0 implementation baseline**. The core host/runner/session loop exists, and the decisions below are the baseline it should continue to follow as the implementation hardens.

---

## v0 scope (locked)

- Ship **one** npm package + **one** command: `rootgrid`.
- Implement everything in **Node.js**, **JavaScript**, **ESM-only** (no TypeScript pipeline).
- **Web UI only** (no terminal/CLI UX for agent sessions).
- **Codex only**, via **`codex app-server`**.
- Host platforms: **Linux**, **macOS**, **WSL**.
  - **No native Windows support** in v0 (later: Windows tray UI managing a WSL-hosted Rootgrid).
  - macOS should work, but is not a focus for MVP.

---

## Setup + configuration

### Config file (required)

`rootgrid setup` writes a single JSON config file:

- `~/.rootgrid/config.json`

This file contains **all** settings collected during setup (runner settings + host/upstream settings + autostart choice).

See `docs/setup.md` for the wizard flow and a proposed config shape.

Required config fields (v0):
- `runner.machineId` (stable UUID) + `runner.machineName`
- **separate tokens**:
  - `host.auth.clientToken` (browser/web UI → host)
  - `host.auth.runnerToken` (runner → host)
- `retentionDays` (default `30`)

---

## Service topology

Rootgrid supports two roles:

- **Host mode**: serves web UI + API + realtime; stores state in SQLite; routes sessions.
- **Runner mode**: spawns/supervises Codex sessions and streams events.

v0 default should be **host+runner on one machine** with a localhost-only UI.

Optional: runner connects to an **upstream host** (configured via URL + **runner token**).

---

## Persistence (v0)

Minimum required persistence:

Host (durable):
- SQLite DB (exact path is an implementation detail)
- Stored normalized event/message history + patches/artifacts (subject to `retentionDays`)

Runner (minimal):
- No SQLite required
- Rootgrid does **not** manage or prune Codex’s own history/state (`CODEX_HOME`).
- By default, Codex runs with the user’s normal `CODEX_HOME` so native Codex can resume the same sessions and user settings apply.
- optional on-disk “outbox spool” so events aren’t lost during brief host disconnects

Retention (v0):
- `retentionDays` defaults to `30` and applies to **everything** Rootgrid persists.

---

## Autostart (v0)

`rootgrid setup` should offer:
- **systemd --user** autostart (Linux environments where systemd is present)

macOS autostart (launchd) is out of scope for v0 (print manual instructions instead).

---

## Reverse proxy support (required for host mode)

Host mode must work behind a reverse proxy (TLS termination + WS upgrade).

Minimum requirements:
- support WebSocket upgrades
- support SSE streaming (disable buffering for `/api/events`)
- respect `X-Forwarded-Proto` / `X-Forwarded-Host` when `host.trustProxy=true`

---

## Protocol + streaming (v0)

Browser control plane:
- REST: `HTTP /api/*`
- Realtime: `GET /api/events` (SSE)

Runner connectivity:
- Control plane: `WS /v1/runner/ws`
- Tunnel/data plane (VS Code): `WS /v1/tunnel` (opened on-demand)

Message envelope and required message types live in `docs/protocol.md`.

---

## Codex integration (v0)

Rootgrid must:
- spawn `codex app-server` as a supervised child process per session
- drive it via JSON-RPC (stdio)
- read streaming output via JSON-RPC **notifications** (no SSE)
- map Codex events into Rootgrid’s normalized event model (`session.output`, `session.status`, `diff.updated`, ...)
- approvals/sandbox are **Codex-managed** (Rootgrid sets the policy and forwards approval prompts/decisions via the web UI)

See `docs/integrations/codex.md`.
