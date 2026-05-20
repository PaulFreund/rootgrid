# Design decisions

This file records **dated** product/architecture decisions. It’s context for implementation and future tradeoffs, not a set of hard rules.

## 2026-03-02 — Pivot to a single Node.js package (`rootgrid`)

This supersedes the earlier multi-binary plan (`rootd` in Go, `rootgrid` in Rust, VS Code extension/Electron app).

New baseline:
- Ship **one** npm package + **one** command: `rootgrid`.
- Implement everything in **Node.js**, **JavaScript**, **ESM-only**.
- v0 agent integration: **Codex only**, via **`codex app-server`** (structured control + streaming).
- User-facing UX is **web UI only** (no terminal/CLI UX for agent sessions).
- Web UI stack (v0): **Vue + Vite** (JavaScript-only), packaged as a **PWA**; use **shadcn-vue** for UI components.
- Supported hosts: **Linux**, **macOS**, and **WSL**. **No native Windows support** yet.
  - Later: add a Windows tray/desktop UI that can manage a WSL-hosted `rootgrid`.
- Config lives at: `~/.rootgrid/config.json` (written by `rootgrid setup`).
- Identity + auth (v0):
  - each runner has a stable `machineId` (UUID)
  - host uses **separate tokens**:
    - browser/web UI → host (client token)
    - runner → host (runner token)
- Codex integration details (v0):
  - run `codex app-server` against the user’s normal `CODEX_HOME` by default (so Codex settings apply and native Codex can resume threads)
  - Rootgrid retention (`retentionDays`) applies to **Rootgrid** data only; Rootgrid does not prune Codex history/state
  - approvals/sandboxing are **Codex-managed** (Rootgrid sets the policy and relays approval prompts/decisions through the web UI)
- Retention (v0): `retentionDays` defaults to **30 days** and applies to everything persisted.

## 2026-02-04 — Languages and core topology

> Superseded by the 2026-03-02 pivot.

- `rootgrid` is **Rust** (cross-platform runtime, PTY/process/fs primitives, single-binary daemon).
- `rootd` is **Go** (control plane API + router; runs locally and in the cloud as the same service in different modes/configs).
- UI clients are **JavaScript** (VS Code webviews + Electron desktop app). No TypeScript build pipeline.

Topology:
- UIs always connect to **`rootd`**.
- `rootgrid` runs per execution context (Windows, each WSL distro, containers/SSH).
- `rootgrid` instances initiate/maintain outbound connections to local `rootd`.
- Local `rootd` can optionally connect upstream to another `rootd` (typically cloud) over WebSocket for sync/routing.

## 2026-02-04 — Data model, storage, and streams

> Superseded in part by the 2026-03-02 pivot (implementation language + packaging changed), but the data-model ideas may still apply.

- Streams are **message/event based**.
- v0 encoding: **JSON**; design keeps the option to negotiate **binary** encodings + compression later.
- User-editable config: **JSON files**.
- Durable/queryable local state: **SQLite**.
- Data is stored **by day** and older than **30 days** is uncached by default (v0: delete per-day cached files from disk; keep durable metadata in SQLite).

## 2026-02-04 — Trust model (v0)

> Superseded by the 2026-03-02 pivot (token-based upstream config is now the baseline assumption).

- `rootd` generates a long-lived **public/private keypair** on first start.
- `rootgrid` (and relaying `rootd`) require the server `rootd` **public key** to connect (server identity / TOFU style).
- Local `rootd` is reachable from localhost without user auth in v0.
- Cloud user auth will be added later (e.g. OIDC).
- Public keys are stored in OpenSSH `ssh-ed25519 ...` format; the desktop app discovers upstream keys automatically on first connect.

## 2026-02-04 — Installer baseline (v0)

> Superseded by the 2026-03-02 pivot (npm-installed `rootgrid`, with optional systemd autostart).

- Windows: install one Windows service, `rootgridsvc` (autostart), which starts/monitors `rootd` + `rootgrid` processes (including selected WSL distros) and runs under the developer user account (not LocalSystem).
- Default wiring: `rootgrid` connects to local `rootd`; local `rootd` may connect to an upstream `rootd`.
