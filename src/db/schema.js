export const SCHEMA_VERSION = 1

export const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS machines (
  machine_id TEXT PRIMARY KEY,
  machine_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  capabilities_json TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  codex_thread_id TEXT,
  FOREIGN KEY(machine_id) REFERENCES machines(machine_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts_ms INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS events_by_session_seq ON events(session_id, seq);
`

