PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pairs (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  time_zone TEXT NOT NULL,
  plan_version INTEGER NOT NULL DEFAULT 1,
  invite_hash TEXT,
  invite_expires_at TEXT
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY NOT NULL,
  pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('child', 'adult')),
  position INTEGER NOT NULL CHECK (position IN (0, 1)),
  token_hash TEXT NOT NULL UNIQUE,
  max_user_id TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS members_pair_id ON members(pair_id);
CREATE UNIQUE INDEX IF NOT EXISTS members_pair_position ON members(pair_id, position);

CREATE TABLE IF NOT EXISTS marks (
  pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  at TEXT NOT NULL,
  by_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (pair_id, day)
);

CREATE TABLE IF NOT EXISTS question_days (
  pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  opened_at TEXT NOT NULL,
  replaced INTEGER NOT NULL DEFAULT 0 CHECK (replaced IN (0, 1)),
  skipped_at TEXT,
  PRIMARY KEY (pair_id, day)
);

CREATE TABLE IF NOT EXISTS daily_notifications (
  pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (pair_id, day, member_id)
);

CREATE TABLE IF NOT EXISTS private_notes (
  pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (pair_id, member_id, day)
);

CREATE TABLE IF NOT EXISTS diagnostic_events (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  stage TEXT NOT NULL,
  error_type TEXT NOT NULL,
  error_code TEXT NOT NULL,
  message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry_events (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  event_name TEXT NOT NULL,
  stage TEXT NOT NULL,
  result TEXT NOT NULL,
  duration_ms INTEGER,
  http_status INTEGER,
  app_version TEXT,
  platform TEXT
);
CREATE INDEX IF NOT EXISTS telemetry_created_at ON telemetry_events(created_at);
CREATE INDEX IF NOT EXISTS telemetry_summary ON telemetry_events(event_name, stage, result, created_at);

CREATE TABLE IF NOT EXISTS bot_welcomes (
  max_user_id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_welcomes_updated_at ON bot_welcomes(updated_at);
