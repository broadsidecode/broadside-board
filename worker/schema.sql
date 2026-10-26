-- Board tables. Every table carries the board_ prefix so the database can be shared with other tools.
-- Card documents keep every field in `data` (JSON text); the indexed columns are copies taken from the card on each write.
CREATE TABLE IF NOT EXISTS board_boards (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_tasks (
  id TEXT PRIMARY KEY,
  board TEXT,
  key TEXT,
  status TEXT,
  kind TEXT,
  lane TEXT,
  data TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS board_tasks_board ON board_tasks(board);
CREATE INDEX IF NOT EXISTS board_tasks_key ON board_tasks(key);
CREATE INDEX IF NOT EXISTS board_tasks_status ON board_tasks(status);
CREATE TABLE IF NOT EXISTS board_counters (
  id TEXT PRIMARY KEY,
  next INTEGER NOT NULL,
  version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS board_history_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  who TEXT NOT NULL,
  task_id TEXT,
  what TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS board_history_task ON board_history_log(task_id);
-- OAuth state for the remote MCP endpoint. Codes and tokens are stored only as HMAC hashes.
CREATE TABLE IF NOT EXISTS board_oauth_clients (
  client_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_oauth_codes (
  hash TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS board_oauth_tokens (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

-- Service tokens bound to one board. client_id is the Access token's client id (not secret).
CREATE TABLE IF NOT EXISTS board_principals (
  client_id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  board TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
