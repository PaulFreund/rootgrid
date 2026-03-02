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
- [ ] Add `npm run build` (root) that builds the web UI and makes `web/dist` available for the host
- [ ] Add `npm run dev` workflow for local development:
  - host API on `127.0.0.1:7337`
  - Vite dev server proxying `/api` + `/vscode` + WS upgrades

---

## 1) `rootgrid setup` (wizard) — finish MVP behavior

- [ ] Fix current readline issues + make wizard robust in non-interactive shells (clear errors, safe defaults)
- [ ] Prereq checks:
  - [ ] Node version check (and error/help if too old)
  - [ ] `codex --version` check (required)
  - [ ] `code-server --version` check (optional; needed for VS Code web viewer)
  - [ ] `git --version` check (optional)
- [ ] Offer installs:
  - [ ] Codex install flow (official method; platform-aware messaging)
  - [ ] code-server install flow (official method; platform-aware messaging)
- [ ] Autostart:
  - [ ] Detect `systemd --user`
  - [ ] Write `~/.config/systemd/user/rootgrid.service`
  - [ ] `systemctl --user enable --now rootgrid`
- [ ] Config writing:
  - [ ] Create `~/.rootgrid/config.json` (0600) and ensure dir perms (0700)
  - [ ] Ensure host-vs-upstream mutual exclusion
  - [ ] Make machine id stable (UUID generated once)
- [ ] UX:
  - [ ] At end of setup, print:
    - local URL (host mode)
    - client token (show once, “store it now”)
    - runner token (show once, “store it now”)

---

## 2) Host (control plane) — production-grade enough for MVP

### 2.1 Auth/session
- [ ] Replace in-memory sessions with stateless signed cookies:
  - [ ] Create `~/.rootgrid/secret.key` on first start (0600)
  - [ ] Cookie: `rootgrid_session=<signed>` (HttpOnly, SameSite=Lax)
  - [ ] Verify cookie on every `/api/*` + `/api/events`
- [ ] Ensure `/api/settings` never returns tokens (redact `clientToken` / `runnerToken`)
- [ ] Add basic request logging (optional debug mode)

### 2.2 REST API surfaces (minimal but complete for MVP UI)
- [ ] Machines:
  - [ ] `GET /api/machines`
- [ ] Sessions:
  - [ ] `GET /api/sessions`
  - [ ] `POST /api/sessions` (start new session; includes options: model/approvalPolicy/sandbox)
  - [ ] `GET /api/sessions/:id` (metadata + current status)
  - [ ] `POST /api/sessions/:id/messages` (send user message → runner)
  - [ ] `POST /api/sessions/:id/cancel`
  - [ ] `POST /api/sessions/:id/stop`
- [ ] Approvals:
  - [ ] `POST /api/approvals/:approvalId` (decision + optional reason)
- [ ] IDE sessions (VS Code web):
  - [ ] `POST /api/ide-sessions` (start code-server on runner; returns `ideId` + url path)
  - [ ] `POST /api/ide-sessions/:ideId/stop`

### 2.3 SSE (realtime)
- [ ] Keep an in-memory list of active SSE clients (broadcast to all)
- [ ] Ensure reverse-proxy friendliness:
  - [ ] disable buffering headers (`Cache-Control: no-transform`, etc.)
  - [ ] heartbeats
- [ ] Define which events are broadcast (at minimum):
  - [ ] registry snapshot/upserts
  - [ ] session status/output
  - [ ] diff updates
  - [ ] approval requests/resolutions
  - [ ] IDE session state updates

### 2.4 SQLite persistence + retention
- [ ] Finalize minimal schema for MVP:
  - machines
  - sessions
  - events (normalized stream)
  - approvals (pending/resolved)
  - ide_sessions
- [ ] Implement retention job:
  - [ ] periodic prune based on `config.retentionDays` (default 30)
  - [ ] safe deletes (by timestamp), cascade or explicit cleanup

### 2.5 Reverse proxy support
- [ ] Implement `host.trustProxy` behavior (X-Forwarded-* handling)
- [ ] Add docs snippets for nginx/caddy (SSE no buffering + WS upgrade)

---

## 3) Runner (execution plane) — MVP

### 3.1 Runner ↔ Host connectivity
- [ ] WS client:
  - [x] connect + hello + heartbeats
  - [ ] reconnect + resume behavior (best-effort for MVP)
- [ ] Implement host→runner routing messages:
  - [ ] `session.start`
  - [ ] `session.send`
  - [ ] `session.cancel`
  - [ ] `session.stop`
  - [ ] `approval.respond`
  - [ ] `ide.start` / `ide.stop` (or equivalent)

### 3.2 Codex `app-server` session manager
- [ ] Implement JSON-RPC client (stdio):
  - [ ] `initialize`
  - [ ] `thread/start`
  - [ ] `thread/resume` (optional for MVP, but recommended)
  - [ ] `turn/start`
  - [ ] `turn/interrupt`
- [ ] Session lifecycle:
  - [ ] map one Rootgrid session ↔ one Codex thread
  - [ ] keep track of `threadId` and current `turnId`
  - [ ] on cancel: interrupt current turn
  - [ ] on stop: terminate app-server child cleanly
- [ ] Event handling:
  - [ ] parse JSON-RPC notifications and emit normalized Rootgrid events:
    - assistant output (delta + finalized message)
    - status/turn boundaries
    - `turn/diff/updated` → `diff.updated`
- [ ] Approvals (Codex-managed):
  - [ ] handle JSON-RPC **requests** from app-server:
    - command approval
    - file-change approval
    - user-input request
  - [ ] forward `approval.request` to host/UI
  - [ ] await `approval.respond` from host/UI
  - [ ] reply to Codex app-server with the mapped decision

### 3.3 Runner event delivery reliability
- [ ] Add monotonic `seq` per session output stream
- [ ] Add optional local outbox spool until host ACKs (recommended even for MVP)
- [ ] Host ACK message type + runner resend logic (at-least-once)

---

## 4) VS Code web viewer (code-server) + tunnel (data plane)

### 4.1 Decide + document the “code-server contract”
- [ ] Runner starts code-server bound to `127.0.0.1:<port>`
- [ ] Rootgrid is the only entry point; browser never talks to runner directly
- [ ] code-server runs with `--auth none` (Rootgrid host auth is the gate)

### 4.2 Implement `/v1/tunnel` framing + multiplexing
- [ ] Write down the exact tunnel protocol framing (streams open/data/close + error)
- [ ] Implement tunnel WS:
  - [ ] runner side (connect, accept stream open, connect to local tcp target)
  - [ ] host side (accept browser request, open stream, forward bytes)
- [ ] Support:
  - [ ] HTTP request/response
  - [ ] WebSocket upgrade forwarding (bidirectional)
- [ ] Enforce limits:
  - [ ] max concurrent streams
  - [ ] per-stream buffer/backpressure
  - [ ] idle timeouts

### 4.3 Host HTTP router for IDE
- [ ] Implement `/vscode/<ideId>/...`:
  - [ ] rewrite/proxy through tunnel to correct runner + code-server port
  - [ ] support WS upgrades under `/vscode/<ideId>`

---

## 5) Web UI (Vue + Vite + PWA) — MVP

- [ ] Scaffold `web/` with:
  - [ ] Vue (JS-only) + Vite
  - [ ] Tailwind + shadcn-vue
  - [ ] `vite-plugin-pwa` (`injectManifest`, autoUpdate)
- [ ] Auth screen:
  - [ ] token entry → `POST /api/auth` → cookie session
- [ ] Global app shell:
  - [ ] connect SSE (`/api/events`) and maintain in-browser state store
- [ ] Machines page:
  - [ ] list machines, status (last-seen)
- [ ] Sessions:
  - [ ] list sessions
  - [ ] create/start session (cwd + model + approvalPolicy + sandbox)
  - [ ] session view with streaming output
- [ ] Approvals UI:
  - [ ] show pending approvals (command/file-change/user-input)
  - [ ] send decision to `POST /api/approvals/:approvalId`
- [ ] Diff UI:
  - [ ] show current unified diff (from `diff.updated`)
- [ ] IDE viewer:
  - [ ] “Open VS Code” button → `POST /api/ide-sessions` → open `/vscode/<ideId>/`
- [ ] Basic settings UI:
  - [ ] show retentionDays (and other non-secret settings)

---

## 6) MVP verification + documentation polish

- [ ] Add a short “MVP runbook” section to `README.md`:
  - install (`npx rootgrid setup`)
  - start (`npx rootgrid`)
  - login to UI (token)
  - start a session + handle approvals
  - open VS Code web viewer
- [ ] Add reverse proxy examples (nginx + caddy) in docs
- [ ] Add troubleshooting notes:
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

