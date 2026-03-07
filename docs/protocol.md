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
- `seq`: number (optional; runner → host delivery sequence for ACK/resend)


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
  - query:
    - `archived=1|true` (list archived sessions)
    - `archived=all` (list both archived + non-archived)
    - `limit` (default 200; max 500)
    - `beforeUpdatedMs`, `beforeSessionId` (cursor for older session rows)
  - default: returns **non-archived** sessions only
  - response: `{ sessions, hasMoreBefore, nextBeforeUpdatedMs, nextBeforeSessionId }`
- `POST /api/sessions` body: `{ machineId?, cwd, prompt, options?, attachments? }`
  - `options` are forwarded to the runner/Codex app-server and include:
    - `model?`
    - `approvalPolicy?`: `"untrusted" | "on-request" | "never" | "on-failure"` (matches Codex CLI)
    - `sandbox?`: `"read-only" | "workspace-write" | "danger-full-access"` (matches Codex CLI)
  - `attachments` (optional): `[{ filename, mimeType, contentBase64 }]`
    - v0 transport: base64-encoded bytes embedded in JSON
    - rule: at least one of `prompt` or `attachments` must be non-empty
    - limit: max **50MB** per attachment (host should return `413` if exceeded)
- `POST /api/sessions/:sessionId/uploads?filename=<name>`
  - request body: raw file bytes
  - headers:
    - `Content-Type`: file MIME type
  - response: `{ uploadId, filename, mimeType, sizeBytes, url }`
  - preferred browser upload path for large attachments; avoids base64 inflation in the web UI
- `GET /api/sessions/:sessionId`
  - query:
    - `bootstrap=1`: return the session row plus an initial summary event window for faster thread open
    - `limit`, `prefetchPages`, `prefetchLimit` (bootstrap tuning; internal/defaulted)
  - bootstrap response: `{ session, events, hasMoreBefore, nextBeforeSeq, containsInput, pagesFetched }`
- `GET /api/sessions/:sessionId/uploads/:uploadId`
  - streams a stored upload/attachment (images are served `inline`, other files as `attachment`)
- `GET /api/sessions/:sessionId/events`
  - query:
    - `mode=summary|full` (default `summary`)
    - `beforeSeq` (pagination cursor; fetch older events with `seq < beforeSeq`)
    - `afterSeq` (forward cursor; fetch newer events with `seq > afterSeq`, used for reconnect/backfill)
    - `limit` (default 200; max 2000)
  - response:
    - backward paging: `{ events, hasMoreBefore, nextBeforeSeq }`
    - forward paging: `{ events, hasMoreAfter, nextAfterSeq }`
- `GET /api/sessions/:sessionId/items/:itemId/output`
  - paginated tool output (typically `session.output` `stdout|stderr`) for a Codex `itemId`
  - query: `beforeSeq`, `limit`
- `PUT /api/sessions/:sessionId` body: `{ title?: string|null, projectLabel?: string|null }`
  - renames how the session is labeled in the UI (chat title + project label)
- `PUT /api/sessions/:sessionId/options` body: `{ options: { model?, approvalPolicy?, sandbox? } }`
  - Updates the session’s Codex options for subsequent turns (applied on the next `turn/start`).
- `POST /api/sessions/:sessionId/messages` body: `{ text, attachments? }`
  - `attachments` may be either:
    - uploaded refs: `[{ uploadId }]`
    - inline base64 payloads: `[{ filename, mimeType, contentBase64 }]`
  - rule: at least one of `text` or `attachments` must be non-empty
- `POST /api/sessions/:sessionId/cancel`
- `POST /api/sessions/:sessionId/stop`
- `POST /api/sessions/:sessionId/read` (mark session as read; advances `lastReadSeq` to `lastSeq`)
- `POST /api/sessions/:sessionId/archive` (archive session; hides it from the default session list)
- `POST /api/sessions/:sessionId/unarchive`
- `DELETE /api/sessions/:sessionId` (delete session; cascades to events/approvals/uploads)

Approvals:
- `POST /api/approvals/:approvalId`
  - For `kind: "command" | "fileChange"`: body `{ decision, reason? }`
    - `decision`: `"accept" | "acceptForSession" | "decline" | "cancel"`
  - For `kind: "userInput"`: body `{ answers }`
    - `answers`: `{ [questionId: string]: { answers: string[] } }`

Settings:
- `GET /api/settings`
- `PUT /api/settings`

IDE (VS Code web):
- `POST /api/ide-sessions` body: `{ machineId?, cwd }` → `{ ideId, urlPath }`
- `POST /api/ide-sessions/:ideId/stop`

Code-server contract (v0):
- Runner spawns `code-server` bound to `127.0.0.1:<port>` (runner-local only).
- Rootgrid proxies it to the browser under: `/vscode/<ideId>/...`.
- Rootgrid relies on host auth; `code-server` is started with `--auth none`.
- Rootgrid uses a per-session base path: `--base-path /vscode/<ideId>`.

---

## Browser realtime (SSE)

Endpoint:
- `GET /api/events`

Visibility tracking:
- The server assigns each SSE connection a `connectionId` (returned in the initial `registry.snapshot` payload).
- The browser may include an initial hint: `GET /api/events?visibility=visible|hidden`
- Optional subscription scoping (bandwidth/CPU):
  - `GET /api/events?sessionId=<sessionId>`: stream full session output/diffs/etc **only** for that session (while still receiving lightweight global events like approvals/turn boundaries).
  - `GET /api/events?all=true`: debug/power-user mode (broadcast everything).
  - `GET /api/events?machineId=<machineId>`: receive machine-scoped events (future-friendly; v0 mostly uses session scoping).
- Resume hint:
  - `GET /api/events?...&lastEventId=<id>&resume=1`
  - when the browser already has a live registry state and the host's replay buffer still covers the gap, the host may send a lightweight `registry.hello` handshake instead of a full `registry.snapshot`, then replay missed SSE events.
- The browser should report whether the tab/app is visible:
  - `POST /api/visibility` body: `{ connectionId, visibility: "visible"|"hidden" }`

Encoding:
- SSE frames use `data: <json>\n\n` where `<json>` is an `Envelope` object.
- Recent events include SSE `id:` lines so reconnecting browsers can resume with `Last-Event-ID` / `lastEventId`.
- Server sends periodic `heartbeat` envelopes to keep proxies from timing out:
  - `type: "heartbeat"`, `payload: { ts }`

Implementation note:
- The host maintains an in-memory set of active SSE clients so it can broadcast realtime events to all connected browsers/tabs/devices.

---

## Runner message types (v0)

### Delivery ACKs (runner ↔ host) (v0)

To avoid losing runner events during brief disconnects, the runner may attach a monotonically increasing `seq`
number to any runner → host envelope on `WS /v1/runner/ws`.

Host → runner:
- `ack` payload: `{ seq }` (the highest runner `seq` the host has processed/recorded)

Runner behavior (recommended v0):
- keep an in-memory (and optionally on-disk) outbox of envelopes with `seq > lastAckSeq`
- on reconnect, replay pending envelopes in `seq` order

Host behavior (required for correctness):
- treat envelopes as **at-least-once**; dedupe using durable ids (e.g. `envelope.id` / `event_id`)

### Machine registry (host → browser via SSE)

- `registry.snapshot`
  - payload: `{ connectionId, machines: [...], sessions: [...], sessionsHasMore, sessionsNextBeforeUpdatedMs, sessionsNextBeforeSessionId, approvals: [...] }`
  - `sessions` in the snapshot are the first page of the default session list (v0: non-archived only); the browser may page older rows through `GET /api/sessions`
- `registry.machine.upsert`
- `registry.machine.remove`
- `registry.session.upsert`
- `registry.session.delete`

### UI notifications (host → browser via SSE)

- `toast`
  - payload: `{ level: "success"|"warning"|"error"|"info", title, message, sessionId?, notificationKey? }`
  - `notificationKey` is a stable dedupe key shared with browser Notification tags / Web Push tags
  - Delivery is controlled by host setting: `notifications.sseToasts = "always"|"never"|"if-not-visible"`
  - Web Push delivery is controlled by host setting: `notifications.webPush = "always"|"never"|"if-not-visible"`

### Web Push (VAPID)

- `GET /api/push/vapid-public-key` → `{ publicKey }`
- `POST /api/push/subscribe` body: a Web Push subscription (`{ endpoint, keys: { p256dh, auth } }`)
- `DELETE /api/push/subscribe` body: `{ endpoint }`

### Liveness (runner → host)

- `machine.alive`
  - payload: `{ machineId }` (v0 minimal; host uses envelope `ts` for `lastSeenMs`)

### Sessions (host → runner)

These are internal routing messages sent from host → runner over `WS /v1/runner/ws`:

- `session.start` payload: `{ sessionId, cwd, prompt, input?, options? }`
  - `input` is a Codex app-server `UserInput[]` array (preferred when attachments are present).
- `session.send` payload: `{ sessionId, text, input?, cwd, codexThreadId?, options? }`
  - `input` is a Codex app-server `UserInput[]` array (preferred when attachments are present).
- `session.cancel` payload: `{ sessionId }`
- `session.stop` payload: `{ sessionId }`
- `session.cleanup` payload: `{ sessionId }`
  - Runner stops the session (if running) and deletes runner-local uploads for that session.

Uploads/attachments (host → runner):
- `session.upload` payload: `{ sessionId, uploadId, filename, mimeType, contentBase64 }`

Upload acknowledgements (runner → host; control-plane only):
- `session.uploaded` payload: `{ sessionId, uploadId, path, filename, mimeType, sizeBytes }`
- `session.upload.failed` payload: `{ sessionId, uploadId, error }`

### Approvals (runner ↔ host)

Codex app-server emits approval requests as JSON-RPC requests (e.g. command execution / file change).
Rootgrid forwards these to the UI and returns the user’s decision back to the runner/Codex.

Runner → host → browser (SSE):
- `approval.request`
  - payload (minimum): `{ approvalId, sessionId, kind }`
  - common optional detail: `{ itemId?, threadId?, turnId?, approvalCallbackId?, cwd?, reason?, command? }`
  - command-specific optional detail: `{ commandActions?, availableDecisions?, additionalPermissions?, proposedExecpolicyAmendment?, proposedNetworkPolicyAmendments?, networkApprovalContext? }`
  - file-change optional detail: `{ grantRoot? }`
  - user-input optional detail: `{ questions? }`
  - `kind`: `"command" | "fileChange" | "userInput"`

Browser → host (REST):
- `POST /api/approvals/:approvalId`
  - body: `{ decision, reason? }` (command/file-change)
  - body: `{ answers }` (user-input)
    - Note: hosts should avoid persisting `answers` into session event logs; questions can be marked `isSecret`.

Host → browser (SSE):
- `approval.resolved`
  - payload: `{ approvalId, decision?, reason? }` (user-input may omit/redact decision details)

Host → runner (WS):
- `approval.respond`
  - payload: `{ approvalId, decision, reason? }`

### Session events (runner → host → browser via SSE)

- `session.input`
  - payload: `{ sessionId, text, isInitial?, attachments? }` (emitted by host when a message is sent)
  - `attachments` (optional): `[{ uploadId, filename, mimeType, sizeBytes, url }]`
- `session.output`
  - payload: `{ sessionId, seq, stream: "stdout"|"stderr"|"normalized"|"reasoning"|"plan", text, itemId? }`
- `session.status`
  - payload: `{ sessionId, status: "starting"|"running"|"stopping"|"exited"|"failed", exitCode?, error? }`
- `thread.tokenUsage.updated`
  - payload: `{ sessionId, threadId?, turnId?, tokenUsage }`
- `token.count` (legacy/wrapped)
  - payload: `{ sessionId, info?, rateLimits? }`
- `turn.started`
  - payload: `{ sessionId, turnId? }`
- `turn.completed`
  - payload: `{ sessionId, turnId?, status?: "completed"|"failed"|"interrupted", error?, preview? }`
- `diff.updated`
  - payload: `{ sessionId, diff, stats? }` (unified diff; typically driven by Codex `turn/diff/updated`)
- `plan.updated`
  - payload: `{ sessionId, threadId?, turnId?, explanation?, plan: [{ step, status }] }`
- `tool.started`
  - payload: `{ sessionId, tool: "commandExecution"|"fileChange", itemId, ... }`
- `tool.completed`
  - payload: `{ sessionId, tool: "commandExecution"|"fileChange", itemId, status?, ... }`

Turn state (runner → host → browser via SSE):
- `turn.started`
  - payload: `{ sessionId, turnId? }`
- `turn.completed`
  - payload: `{ sessionId, turnId?, preview? }` (preview is a short text snippet for session list UX)

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

### Tunnel framing (current implementation)

Binary frame format:
- `u8 type`
- `u32be streamId`
- `payload` (bytes)

Frame `type`:
- `OPEN (0)`: payload is UTF-8 JSON describing the upstream connection:
  - `{ mode: "http"|"tcp", host, port, method?, path?, headers? }`
- `HEADERS (4)`: (http mode only) payload is UTF-8 JSON:
  - `{ statusCode, headers }`
- `DATA (1)`: raw bytes
- `END (2)`: no payload
- `ERROR (3)`: payload is a UTF-8 error message

---

## Sequencing / backfill (v0)

To support reconnect/backfill without text comparison:
- `session.output` must include a **monotonic** `seq` per `{machineId, sessionId}` stream.
- The host should persist `{lastSeq}` and allow UI to request backfill (exact HTTP/WS shape TBD).

This is intentionally minimal; the first implementation can start with “best-effort live streaming” and add
backfill once persistence is in place.
