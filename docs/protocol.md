# Protocol surface (v0)

This document defines Rootgrid’s v0 protocol surfaces.

Principles:
- Browser UI uses simple, proxy-friendly primitives: **REST + SSE**
- Runner connectivity uses **WebSockets**
- VS Code access is provided by **HTTP + WebSocket tunneling** over a separate runner↔host WebSocket
- v0 encoding is **JSON**
- Prefer **durable ids** and **monotonic sequences** over text matching

---

## Surfaces

### Browser ↔ host (control plane)

- REST: `HTTP /api/*`
- Realtime: `GET /api/events` (SSE; server → browser only)
- Auth: browser authenticates using the **client token** (`host.auth.clientToken`) and receives a cookie-based session.
  - (v0 recommendation: use same-origin cookies so SSE does not need tokens in URLs.)

### Runner ↔ host (control plane)

- WebSocket: `WS /v1/runner/ws`
- Auth: runner authenticates using the **runner token** (`host.auth.runnerToken`)

### Runner ↔ host (tunnel / data plane)

- WebSocket: `WS /v1/tunnel`
- Auth: runner authenticates using the **runner token** (`host.auth.runnerToken`)
- Opened **only when needed** (e.g. when a VS Code web session is active).

### Browser ↔ host (VS Code web)

Host exposes an IDE viewer route, for example:
- `GET /vscode/<ideId>/...` (HTTP + WS upgrades)

The host reverse-proxies those HTTP requests and WebSocket upgrades through the runner tunnel to the
runner-local VS Code web server (which should bind to `127.0.0.1`).

---

## Envelope (v0)

Rootgrid uses the same envelope shape for:
- runner WS messages (`/v1/runner/ws`)
- browser SSE messages (`/api/events`)

- `v`: number (schema version, starts at `1`)
- `type`: string (message type discriminator)
- `ts`: number (unix millis)
- `id`: string (UUID)
- `scope`: object (optional routing scope)
  - `machineId?`
  - `sessionId?`
  - `runId?`
- `payload`: object (type-specific)


---

## Handshake + auth

### Runner WebSocket `hello` (runner → host)

`type`: `hello`

`payload`:
- `token`: string (required)
  - must match `host.auth.runnerToken`
- `machine`: (runner only)
  - `id?`: string (stable machine id if already provisioned)
  - `name`: string (human-friendly; defaults to hostname)
  - `platform`: `"linux" | "darwin" | "wsl"`
  - `capabilities?`: object
- `resume?`: object (optional, for reconnect)

Notes:
- v0 runner `hello` does **not** include a `role` field. This endpoint is runner-only.

### `welcome` (host → runner)

`type`: `welcome`

`payload`:
- `hostId`: string
- `protocolVersion`: number
- `assigned`: object (optional)
  - `machineId?`: string (if the host assigned one)
- `resume?`: object (optional)

Auth rule (v0):
- If `token` is missing/invalid, the host must close the connection (after a short `error` response if possible).
- Host must keep **separate tokens** for UI clients and runners (see `docs/setup.md`).

---

## Browser REST API (shape-level, v0)

This is intentionally minimal; the exact request/response schemas can evolve.

Auth:
- `POST /api/auth` body: `{ token: "<clientToken>" }` → sets an HTTP-only session cookie

Machines:
- `GET /api/machines`

Sessions:
- `GET /api/sessions`
- `POST /api/sessions` body: `{ machineId?, cwd, prompt, options? }`
  - `options` are forwarded to the runner/Codex app-server and include:
    - `model?`
    - `approvalPolicy?`: `"untrusted" | "on-request" | "never" | "on-failure"` (matches Codex CLI)
    - `sandbox?`: `"read-only" | "workspace-write" | "danger-full-access"` (matches Codex CLI)
- `GET /api/sessions/:sessionId`
- `POST /api/sessions/:sessionId/messages` body: `{ text }`
- `POST /api/sessions/:sessionId/cancel`
- `POST /api/sessions/:sessionId/stop`

Approvals:
- `POST /api/approvals/:approvalId` body: `{ decision, reason? }`
  - `decision`: `"accept" | "acceptForSession" | "decline" | "cancel"`

Settings:
- `GET /api/settings`
- `PUT /api/settings`

IDE (VS Code web):
- `POST /api/ide-sessions` body: `{ machineId?, cwd }` → `{ ideId, urlPath }`
- `POST /api/ide-sessions/:ideId/stop`

---

## Browser realtime (SSE)

Endpoint:
- `GET /api/events`

Encoding:
- SSE frames use `data: <json>\n\n` where `<json>` is an `Envelope` object.
- Server should send periodic heartbeat comment frames (e.g. `: heartbeat\n\n`) to keep proxies from timing out.
- If the server sets SSE `id:` lines, the browser can resume with `Last-Event-ID` (optional v0 enhancement).

Implementation note:
- The host maintains an in-memory set of active SSE clients so it can broadcast realtime events to all connected browsers/tabs/devices.

---

## Runner message types (v0)

### Machine registry (host → browser via SSE)

- `registry.snapshot`
  - payload: `{ machines: [...], sessions: [...] }` (shape TBD)
- `registry.machine.upsert`
- `registry.machine.remove`

### Liveness (runner → host)

- `machine.alive`
  - payload: `{ machineId, ts, sessions?: [{ sessionId, status }] }`

### Sessions (host → runner)

These are internal routing messages sent from host → runner over `WS /v1/runner/ws`:

- `session.start` payload: `{ machineId?, cwd, prompt, options? }`
- `session.send` payload: `{ sessionId, text }`
- `session.cancel` payload: `{ sessionId }`
- `session.stop` payload: `{ sessionId }`

### Approvals (runner ↔ host)

Codex app-server emits approval requests as JSON-RPC requests (e.g. command execution / file change).
Rootgrid forwards these to the UI and returns the user’s decision back to the runner/Codex.

Runner → host → browser (SSE):
- `approval.request`
  - payload: `{ approvalId, sessionId, kind, reason?, command?, cwd?, grantRoot? }`
  - `kind`: `"command" | "fileChange" | "userInput"`

Browser → host (REST):
- `POST /api/approvals/:approvalId`
  - body: `{ decision, reason? }`

Host → runner (WS):
- `approval.respond`
  - payload: `{ approvalId, decision, reason? }`

### Session events (runner → host → browser via SSE)

- `session.output`
  - payload: `{ sessionId, seq, stream: "stdout"|"stderr"|"normalized", text }`
- `session.status`
  - payload: `{ sessionId, status: "starting"|"running"|"stopping"|"exited"|"failed", exitCode?, error? }`
- `diff.updated`
  - payload: `{ sessionId, diff, stats? }` (unified diff; typically driven by Codex `turn/diff/updated`)

---

## Tunnel (VS Code web) (v0)

Rootgrid supports tunneling of **HTTP + WebSocket** traffic from host → runner so the browser can access a runner-local
VS Code web server.

v0 requirements:
- use a **separate** runner↔host WebSocket (`WS /v1/tunnel`) so tunnel traffic can’t starve the control plane
- support multiple concurrent in-flight streams (multiplexing)

The exact framing is an implementation detail, but the tunnel must be able to carry:
- raw bytes for HTTP request/response bodies
- raw bytes for WebSocket messages (both directions)

---

## Sequencing / backfill (v0)

To support reconnect/backfill without text comparison:
- `session.output` must include a **monotonic** `seq` per `{machineId, sessionId}` stream.
- The host should persist `{lastSeq}` and allow UI to request backfill (exact HTTP/WS shape TBD).

This is intentionally minimal; the first implementation can start with “best-effort live streaming” and add
backfill once persistence is in place.
