# Rootgrid MVP TODO

This file is a **work plan** to finish the v0/MVP based on the current docs:
- `docs/kickoff.md`
- `docs/architecture.md`
- `docs/protocol.md`
- `docs/setup.md`
- `docs/integrations/codex.md`

Scope reminders (v0):
- **One** npm package + **one** command: `rootgrid`
- **Node.js + JavaScript + ESM-only** (no TypeScript pipeline)
- **Web UI only** for day-to-day usage (only `rootgrid setup` is CLI)
- **Codex only**, via **`codex app-server`**
- browser ↔ host: **REST + SSE**
- runner ↔ host: **WS control plane**
- VS Code viewer: **HTTP + WS** proxied via host and tunneled via a **separate WS** (`/v1/tunnel`)
- Approvals/sandbox are **Codex-managed** (Rootgrid sets policy; Codex decides when to ask; Rootgrid relays prompts/decisions)
- Default Codex `CODEX_HOME` is **not isolated** (Rootgrid retention prunes Rootgrid DB only)

---

## 0) Repo hygiene / baseline

- [x] Rename `gridd` → `rootgrid` (docs + code)
- [x] Minimal host scaffold: REST auth + SSE + machine registry + runner WS registration
- [x] Add `npm run build` (root) that builds the web UI and makes `web/dist` available for the host
- [x] Add `npm run dev` workflow for local development:
  - host API on `127.0.0.1:7337`
  - Vite dev server proxying `/api` + `/vscode` + WS upgrades

---

## 1) `rootgrid setup` (wizard) — finish MVP behavior

- [x] Fix current readline issues + make wizard robust in non-interactive shells (clear errors, safe defaults)
- [x] Prereq checks:
  - [x] Node version check (and error/help if too old)
  - [x] `codex --version` check (required)
  - [x] `code-server --version` check (optional; needed for VS Code web viewer)
  - [x] `git --version` check (optional)
- [x] Offer installs:
  - [x] Codex install flow (official method; platform-aware messaging)
  - [x] code-server install flow (official method; platform-aware messaging)
- [x] Autostart:
  - [x] Detect `systemd --user`
  - [x] Write `~/.config/systemd/user/rootgrid.service`
  - [x] `systemctl --user enable --now rootgrid`
- [x] Config writing:
  - [x] Create `~/.rootgrid/config.json` (0600) and ensure dir perms (0700)
  - [x] Ensure host-vs-upstream mutual exclusion
  - [x] Make machine id stable (UUID generated once)
- [x] UX:
  - [x] At end of setup, print:
    - local URL (host mode)
    - client token (show once, “store it now”)
    - runner token (show once, “store it now”)

---

## 2) Host (control plane) — production-grade enough for MVP

### 2.1 Auth/session
- [x] Replace in-memory sessions with stateless signed cookies:
  - [x] Create `~/.rootgrid/secret.key` on first start (0600)
  - [x] Cookie: `rootgrid_session=<signed>` (HttpOnly, SameSite=Lax)
  - [x] Verify cookie on every `/api/*` + `/api/events`
- [x] Ensure `/api/settings` never returns tokens (redact `clientToken` / `runnerToken`)
- [x] Add basic request logging (optional debug mode)

### 2.2 REST API surfaces (minimal but complete for MVP UI)
- [x] Machines:
  - [x] `GET /api/machines`
- [x] Sessions:
  - [x] `GET /api/sessions`
  - [x] `POST /api/sessions` (start new session; includes options: model/approvalPolicy/sandbox)
  - [x] `GET /api/sessions/:id` (metadata + current status)
  - [x] `PUT /api/sessions/:id` (rename project label)
  - [x] `POST /api/sessions/:id/messages` (send user message → runner)
  - [x] `POST /api/sessions/:id/cancel`
  - [x] `POST /api/sessions/:id/stop`
  - [x] `POST /api/sessions/:id/read`
- [x] Approvals:
  - [x] `POST /api/approvals/:approvalId` (decision + optional reason)
- [x] IDE sessions (VS Code web):
  - [x] `POST /api/ide-sessions` (start code-server on runner; returns `ideId` + url path)
  - [x] `POST /api/ide-sessions/:ideId/stop`
  - [x] `/vscode/<ideId>/...` proxy route (HTTP + WS upgrades)
  - [x] `GET/PUT /api/settings` (basic non-secret settings; retentionDays)

### 2.3 SSE (realtime)
- [x] Keep an in-memory list of active SSE clients (broadcast to all)
- [x] Ensure reverse-proxy friendliness:
  - [x] disable buffering headers (`Cache-Control: no-transform`, etc.)
  - [x] heartbeats
- [x] Define which events are broadcast (at minimum):
  - [x] registry snapshot/upserts
  - [x] session status/output
  - [x] diff updates
  - [x] approval requests/resolutions
  - [x] IDE session state updates

### 2.4 SQLite persistence + retention
- [x] Finalize minimal schema for MVP:
  - [x] machines
  - [x] sessions
  - [x] events (normalized stream)
  - [x] approvals (pending)
  - [x] ide_sessions
- [x] Implement retention job:
  - [x] periodic prune based on `config.retentionDays` (default 30)
  - [x] safe deletes (by timestamp), cascade or explicit cleanup

### 2.5 Reverse proxy support
- [x] Implement `host.trustProxy` behavior (X-Forwarded-* handling)
- [x] Add docs snippets for nginx/caddy (SSE no buffering + WS upgrade)

---

## 3) Runner (execution plane) — MVP

### 3.1 Runner ↔ Host connectivity
- [x] WS client:
  - [x] connect + hello + heartbeats
  - [x] reconnect + resume behavior (best-effort for MVP)
- [x] Implement host→runner routing messages:
  - [x] `session.start`
  - [x] `session.send`
  - [x] `session.cancel`
  - [x] `session.stop`
  - [x] `approval.respond`
  - [x] `ide.start` / `ide.stop` (or equivalent)

### 3.2 Codex `app-server` session manager
- [x] Implement JSON-RPC client (stdio):
  - [x] `initialize`
  - [x] `thread/start`
  - [x] `thread/resume` (optional for MVP, but recommended)
  - [x] `turn/start`
  - [x] `turn/interrupt`
- [x] Session lifecycle:
  - [x] map one Rootgrid session ↔ one Codex thread
  - [x] keep track of `threadId` and current `turnId`
  - [x] on cancel: interrupt current turn
  - [x] on stop: terminate app-server child cleanly
- [x] Event handling:
  - [x] parse JSON-RPC notifications and emit normalized Rootgrid events:
    - assistant output (delta + finalized message)
    - status/turn boundaries
    - `turn/diff/updated` → `diff.updated`
- [x] Approvals (Codex-managed):
  - [x] handle JSON-RPC **requests** from app-server:
    - command approval
    - file-change approval
  - [x] user-input request
  - [x] forward `approval.request` to host/UI
  - [x] await `approval.respond` from host/UI
  - [x] reply to Codex app-server with the mapped decision

### 3.3 Runner event delivery reliability
- [x] Add monotonic `seq` per session output stream
- [x] Add optional local outbox spool until host ACKs (recommended even for MVP)
- [x] Host ACK message type + runner resend logic (at-least-once)

---

## 4) VS Code web viewer (code-server) + tunnel (data plane)

### 4.1 Decide + document the “code-server contract”
- [x] Runner starts code-server bound to `127.0.0.1:<port>`
- [x] Rootgrid is the only entry point; browser never talks to runner directly
- [x] code-server runs with `--auth none` (Rootgrid host auth is the gate)

### 4.2 Implement `/v1/tunnel` framing + multiplexing
- [x] Write down the exact tunnel protocol framing (streams open/data/close + error)
- [x] Implement tunnel WS:
  - [x] runner side (connect, accept stream open, connect to local tcp target)
  - [x] host side (accept browser request, open stream, forward bytes)
- [x] Support:
  - [x] HTTP request/response
  - [x] WebSocket upgrade forwarding (bidirectional)
- [x] Enforce limits:
  - [x] max concurrent streams
  - [x] per-stream buffer/backpressure
  - [x] idle timeouts

### 4.3 Host HTTP router for IDE
- [x] Implement `/vscode/<ideId>/...`:
  - [x] rewrite/proxy through tunnel to correct runner + code-server port
  - [x] support WS upgrades under `/vscode/<ideId>`

---

## 5) Web UI (Vue + Vite + PWA) — MVP

- [x] Scaffold `web/` with:
  - [x] Vue (JS-only) + Vite
  - [x] Tailwind + shadcn-vue-style components
  - [x] `vite-plugin-pwa` (autoUpdate)
- [x] Auth screen:
  - [x] token entry → `POST /api/auth` → cookie session
- [x] Global app shell:
  - [x] connect SSE (`/api/events`) and maintain in-browser state store
- [x] Machines page:
  - [x] list machines, status (last-seen)
- [x] Sessions:
  - [x] list sessions
  - [x] create/start session (cwd + model + approvalPolicy + sandbox)
  - [x] session view with streaming output
- [x] Approvals UI:
  - [x] show pending approvals (command/file-change)
  - [x] send decision to `POST /api/approvals/:approvalId`
- [x] Diff UI:
  - [x] show current unified diff (from `diff.updated`)
- [x] IDE viewer:
  - [x] “Open VS Code” button → `POST /api/ide-sessions` → open `/vscode/<ideId>/`
- [x] Basic settings UI:
  - [x] show retentionDays (and other non-secret settings)

---

## 6) MVP verification + documentation polish

- [x] Add a short “MVP runbook” section to `README.md`:
  - install (`npx rootgrid setup`)
  - start (`npx rootgrid`)
  - login to UI (token)
  - start a session + handle approvals
  - open VS Code web viewer
- [x] Add reverse proxy examples (nginx + caddy) in docs
- [x] Add troubleshooting notes:
  - codex not found / auth issues
  - SSE behind proxy buffering
  - WS upgrade issues
  - code-server missing

---

## Out of scope for MVP (explicitly later)

- Windows-native service/tray UI
- Multi-tenant user accounts
- Full audit/security hardening (mTLS/device trust, etc.)
- Additional agent integrations beyond Codex
