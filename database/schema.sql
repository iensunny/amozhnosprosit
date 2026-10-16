CREATE TABLE pairs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  time_zone TEXT NOT NULL,
  plan_version INTEGER NOT NULL DEFAULT 1,
  invite_hash TEXT,
  invite_expires_at TEXT
);

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('child', 'adult')),
  position INTEGER NOT NULL CHECK (position IN (0, 1)),
  token_hash TEXT NOT NULL UNIQUE,
  max_user_id TEXT,
  UNIQUE (pair_id, position)
);

CREATE UNIQUE INDEX members_max_user_id
  ON members(max_user_id)
  WHERE max_user_id IS NOT NULL;
CREATE INDEX members_pair_id ON members(pair_id);

CREATE TABLE marks (
  pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  at TEXT NOT NULL,
  by_member_id TEXT NOT NULL,
  PRIMARY KEY (pair_id, day)
);

CREATE TABLE question_days (
  pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  opened_at TEXT NOT NULL,
  replaced INTEGER NOT NULL DEFAULT 0 CHECK (replaced IN (0, 1)),
  skipped_at TEXT,
  PRIMARY KEY (pair_id, day)
);

CREATE TABLE daily_notifications (
  pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (pair_id, day, member_id)
);
