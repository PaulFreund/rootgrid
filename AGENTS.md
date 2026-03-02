## Quick Start for Agents

- Read these before larger changes:
  - `README.md` – product and architecture overview.
  - `docs/kickoff.md` – v0 implementation baseline (start here before coding).
  - `docs/architecture.md` – roles (host/runner), storage split, transports.
  - `docs/protocol.md` – REST/SSE + WS surfaces and message types.
  - `docs/setup.md` – `rootgrid setup` wizard + `~/.rootgrid/config.json`.
  - `docs/integrations/codex.md` – Codex `app-server` integration + approvals.
  - `DesignDecisions.md` – dated history of feature‑level decisions (context, not hard rules).
- New general rules (architecture, tooling, global UX) belong in this file and
  `README.md`. Feature‑specific decisions go into `DesignDecisions.md`.

## Architecture & Code Style

- Prefer simple, lean solutions; avoid premature abstractions.
- Keep modules small and reusable; share logic via helpers (for example under
  `src/lib/`) instead of duplicating it across views.
- Favour pure, testable functions and explicit inputs/outputs; minimise hidden
  global state and side effects.

## Technology Guardrails

- **Single package**: ship **one** npm package and **one** command: `rootgrid`.
- **Node.js only**: everything is implemented in **Node.js** using **JavaScript** and **ESM-only** modules.
  - Prefer Node built-ins (`node:http`, `node:sqlite`, etc.) and small dependencies.
- **JavaScript-first**: do **not** introduce TypeScript or a TS build pipeline.
  - If you want type-safety, prefer **JSDoc + runtime schemas** (e.g. `zod`) over TypeScript.

Web UI:
- **Vue + Vite** (JavaScript-only), packaged as a **PWA**.
- UX toolkit: **shadcn-vue** (Tailwind-based component set).

Protocol / transports (v0):
- browser ↔ host: **REST + SSE** (`/api/*`, `GET /api/events`)
- runner ↔ host: **WebSocket** (`WS /v1/runner/ws`)
- tunnel/data-plane: **WebSocket** (`WS /v1/tunnel`, opened on-demand)
- Do **not** introduce `socket.io` (proxy complexity + unnecessary for v0).

Codex integration (v0):
- **Codex only**, via **`codex app-server`** (JSON-RPC over stdio).
- Approvals + sandbox are **Codex-managed**:
  - Rootgrid sets the policy (matches Codex CLI) and relays approval prompts/decisions via the web UI.
- Run Codex with the user’s normal `CODEX_HOME` by default so settings apply and native Codex can resume sessions.
- Rootgrid retention (`retentionDays`) prunes **Rootgrid data only** (SQLite + Rootgrid artifacts), not Codex history/state.

Platform / UX scope (v0):
- Web UI only (no terminal/CLI UX for agent sessions).
- Linux + WSL are the MVP targets.
- No native Windows support yet (later: Windows tray managing a WSL-hosted Rootgrid).
- macOS should run, but is not a focus for MVP.

## Environment & Tools

- Work in WSL with standard Linux tools.
- Use `npm` for installs/builds; keep installation “npx rootgrid …” simple.
- Git is read‑only for agents (`git log`, `git blame`); humans handle staging and commits.

## Reference implementation notes (optional)

There is a local reference repo at:
- `/mnt/d/prj/references/hapi`

Rootgrid should **not** copy HAPI’s stack (Bun/Hono/TypeScript), but it *can* reuse ideas:
- Codex `app-server` JSON-RPC client patterns
- app-server event conversion patterns (notifications → UI events)
- approval bridging patterns (requestApproval → UI decision → app-server reply)
- Vite PWA configuration patterns

## Testing Checklist (v0 smoke tests)

- `npm install`
- `node src/cli.js --help` prints usage for `rootgrid` commands
- `rootgrid setup` writes `~/.rootgrid/config.json`
- `rootgrid` starts the host (default `http://127.0.0.1:7337`)
- REST auth works:
  - `POST /api/auth` with `host.auth.clientToken` sets an HttpOnly cookie
- SSE works:
  - `GET /api/events` returns an initial `registry.snapshot`
- Basic endpoints work (after auth):
  - `GET /api/settings`
  - `GET /api/machines`
