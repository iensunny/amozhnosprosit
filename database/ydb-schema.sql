CREATE TABLE pairs (
  id Utf8 NOT NULL,
  status Utf8 NOT NULL,
  created_at Utf8 NOT NULL,
  started_at Utf8,
  time_zone Utf8 NOT NULL,
  plan_version Uint32 NOT NULL,
  invite_hash Utf8,
  invite_expires_at Utf8,
  PRIMARY KEY (id)
);

CREATE TABLE members (
  id Utf8 NOT NULL,
  pair_id Utf8 NOT NULL,
  name Utf8 NOT NULL,
  role Utf8 NOT NULL,
  position Uint32 NOT NULL,
  token_hash Utf8 NOT NULL,
  max_user_id Utf8,
  PRIMARY KEY (id)
);

CREATE TABLE marks (
  pair_id Utf8 NOT NULL,
  day Uint32 NOT NULL,
  at Utf8 NOT NULL,
  by_member_id Utf8 NOT NULL,
  PRIMARY KEY (pair_id, day)
);

CREATE TABLE question_days (
  pair_id Utf8 NOT NULL,
  day Uint32 NOT NULL,
  opened_at Utf8 NOT NULL,
  replaced Uint32 NOT NULL,
  skipped_at Utf8,
  PRIMARY KEY (pair_id, day)
);

CREATE TABLE daily_notifications (
  pair_id Utf8 NOT NULL,
  day Uint32 NOT NULL,
  member_id Utf8 NOT NULL,
  sent_at Utf8 NOT NULL,
  PRIMARY KEY (pair_id, day, member_id)
);
