export const SCHEMA_VERSION = 11

export const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS machines (
  machine_id TEXT PRIMARY KEY,
  machine_name TEXT NOT NULL,
  machine_alias TEXT,
  platform TEXT NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  capabilities_json TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  project_label TEXT,
  title TEXT,
  title_source TEXT NOT NULL DEFAULT 'auto',
  preview TEXT,
  status TEXT NOT NULL,
  turn_state TEXT NOT NULL DEFAULT 'idle',
  pending_approvals INTEGER NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL DEFAULT 0,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  codex_thread_id TEXT,
  model TEXT,
  reasoning_effort TEXT,
  approval_policy TEXT,
  sandbox_mode TEXT,
  archived_ms INTEGER,
  FOREIGN KEY(machine_id) REFERENCES machines(machine_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS sessions_by_archived_updated ON sessions(archived_ms, updated_ms DESC);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts_ms INTEGER NOT NULL,
  type TEXT NOT NULL,
  stream TEXT,
  item_id TEXT,
  payload_json TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS events_by_session_seq ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS events_by_session_item ON events(session_id, item_id, seq);
CREATE INDEX IF NOT EXISTS events_by_session_type_stream ON events(session_id, type, stream, seq);

-- Pending approvals (so the UI can recover after refresh/restart).
CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  FOREIGN KEY(machine_id) REFERENCES machines(machine_id) ON DELETE CASCADE,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS approvals_by_session ON approvals(session_id, created_ms);
CREATE INDEX IF NOT EXISTS approvals_by_created ON approvals(created_ms);

-- IDE sessions for VS Code web viewer (best-effort; ephemeral).
CREATE TABLE IF NOT EXISTS ide_sessions (
  ide_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  port INTEGER NOT NULL,
  base_path TEXT,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  FOREIGN KEY(machine_id) REFERENCES machines(machine_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ide_sessions_by_machine ON ide_sessions(machine_id, updated_ms);

-- Web Push subscriptions (VAPID).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS push_subscriptions_by_updated ON push_subscriptions(updated_ms);

-- Session uploads/attachments (stored on the host; runner path is for Codex localImage inputs).
CREATE TABLE IF NOT EXISTS uploads (
  upload_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  host_path TEXT NOT NULL,
  runner_path TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS uploads_by_session ON uploads(session_id, created_ms);

-- Persisted queued follow-up prompts (survive UI reload/reconnect).
CREATE TABLE IF NOT EXISTS queued_prompts (
  prompt_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  text TEXT NOT NULL,
  attachments_json TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS queued_prompts_by_session ON queued_prompts(session_id, created_ms);
`
