# `rootgrid setup` (interactive wizard)

`rootgrid setup` is the only required “CLI interaction” in v0. After setup, all day-to-day usage is via the **web UI**.

It must write configuration to:
- `~/.rootgrid/config.json`

---

## Wizard flow (v0)

### 1) Check prerequisites

Minimum checks:
- `node` version (since Rootgrid runs on Node)
- `codex` availability (`codex --version` or equivalent)

Optional checks (recommended):
- `git` availability (if the UI will show diffs/status)
- `code-server` availability (only needed for VS Code web viewer)
- filesystem permissions for `~/.rootgrid`

### 2) Offer to install missing prerequisites

If prerequisites are missing, offer to install them using the **official** install method (exact command may vary by platform):
- Codex (required for v0)
- `code-server` (optional; required only for VS Code web viewer)

### 3) Autostart (systemd if available)

If `systemd --user` is available, ask:
- “Do you want Rootgrid to autostart on login?”

If yes:
- create a user service (e.g. `~/.config/systemd/user/rootgrid.service`)
- enable + start it

### 4) Runner setup (agent execution on this machine)

Ask:
- “Do you want this machine to run Codex sessions (runner mode)?”

If yes:
- ask for machine name (default: hostname)

### 5) Host vs upstream

Ask one of:

**A) Host mode (serve web UI + API here)**
- listen host (default `127.0.0.1`)
- listen port (default `7337`)
- generate (or set) a **client → host** access token (used by the browser/web UI)
- generate (or set) a **runner → host** access token (used by runners registering to this host)
- (optional) ask if Rootgrid will run **behind a reverse proxy**
  - if yes, set `host.trustProxy=true` and (optionally) ask for `host.publicUrl`

**B) Upstream mode (connect this runner to another Rootgrid host)**
- upstream URL (host websocket base, e.g. `wss://…`)
- upstream **runner token**

### 6) Write `~/.rootgrid/config.json`

Persist all choices from the wizard (including autostart choice and machine name).

### 7) Print next steps

Examples:
- if host mode: print the local URL to open in a browser
- if upstream mode: confirm the machine registered successfully (or how to troubleshoot)

---

## Proposed config shape (v0)

This is a **proposed** starting point; adjust as implementation realities land.

```json
{
  "version": 1,
  "retentionDays": 30,
  "notifications": { "sseToasts": "if-not-visible", "webPush": "if-not-visible" },
  "autostart": { "enabled": false, "method": null },
  "runner": {
    "enabled": true,
    "machineId": "replace-with-uuid",
    "machineName": "my-hostname"
  },
  "host": {
    "enabled": true,
    "listen": { "host": "127.0.0.1", "port": 7337 },
    "publicUrl": null,
    "trustProxy": false,
    "auth": {
      "clientToken": "replace-with-random",
      "runnerToken": "replace-with-random"
    }
  },
  "upstream": {
    "enabled": false,
    "url": null,
    "runnerToken": null
  }
}
```

Notes:
- `runner.machineId` should be a stable UUID generated once (so renaming the machine doesn’t create a “new machine”).
- `retentionDays` defaults to `30` and applies to **all** persisted data (sessions, logs, artifacts) unless explicitly exempted later.
- `notifications.sseToasts` controls toast/desktop notifications delivered over SSE:
  - `"if-not-visible"` (default): send only to hidden tabs
  - `"always"`: send to all connected tabs
  - `"never"`: disable
- `notifications.webPush` controls Web Push delivery (VAPID):
  - `"if-not-visible"` (default): send when the relevant session is not currently open in a visible Rootgrid tab
  - `"always"`: always send push (even while the UI is visible)
  - `"never"`: disable push sends (subscription can remain registered)
- In host mode:
  - `host.auth.clientToken` protects **browser/web UI** access.
  - `host.auth.runnerToken` protects **runner registration**.
- In upstream mode, `upstream.url` and `upstream.runnerToken` are required.
- v0 recommendation: `host.enabled=true` and `upstream.enabled=true` should be treated as **mutually exclusive** (either you host the UI here, or you connect to an upstream host).

---

## “Did we forget anything important?”

Common setup prompts that become painful later if you skip them:

1) **Token generation + rotation**
   - generate strong random tokens by default
   - keep **separate tokens** for:
     - browser/web UI → host (`host.auth.clientToken`)
     - runner → host (`host.auth.runnerToken`)
   - show them once (or provide rotation commands later)

2) **CORS / allowed origins**
   - if the UI is ever hosted on a different origin (or if you build a “hosted UI”), you’ll need an origin allowlist

3) **Data directory override**
   - allow `~/.rootgrid` to be overridden (env var or config) for dev/testing and constrained environments

4) **TLS termination story**
   - in host mode, you may rely on a reverse proxy (Caddy/nginx) for HTTPS
   - in upstream mode, `wss://` should be the expectation
   - reverse proxy must:
     - support WebSocket upgrades (`/v1/runner/ws`, `/v1/tunnel`, and `/vscode/*`)
     - disable response buffering for SSE (`/api/events`)

5) **macOS autostart**
   - if not implementing launchd in v0, print clear manual instructions

6) **Retention / disk usage**
   - `retentionDays` (default `30`) should prune old sessions/logs/artifacts automatically
   - uploads/attachments are stored under `~/.rootgrid/uploads/` and are also pruned (host-side) by retention
