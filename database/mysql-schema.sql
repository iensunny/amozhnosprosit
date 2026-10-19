CREATE TABLE pairs (
  id VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  started_at VARCHAR(32) NULL,
  time_zone VARCHAR(64) NOT NULL,
  plan_version INT UNSIGNED NOT NULL DEFAULT 1,
  invite_hash CHAR(64) NULL,
  invite_expires_at VARCHAR(32) NULL,
  PRIMARY KEY (id),
  CONSTRAINT pairs_status_check CHECK (status IN ('pending', 'active'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE members (
  id VARCHAR(64) NOT NULL,
  pair_id VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(16) NOT NULL,
  position TINYINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  max_user_id VARCHAR(128) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY members_token_hash (token_hash),
  UNIQUE KEY members_pair_position (pair_id, position),
  UNIQUE KEY members_max_user_id (max_user_id),
  KEY members_pair_id (pair_id),
  CONSTRAINT members_pair_fk FOREIGN KEY (pair_id) REFERENCES pairs (id) ON DELETE CASCADE,
  CONSTRAINT members_role_check CHECK (role IN ('child', 'adult')),
  CONSTRAINT members_position_check CHECK (position IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE marks (
  pair_id VARCHAR(64) NOT NULL,
  day INT UNSIGNED NOT NULL,
  at VARCHAR(32) NOT NULL,
  by_member_id VARCHAR(64) NOT NULL,
  PRIMARY KEY (pair_id, day),
  CONSTRAINT marks_pair_fk FOREIGN KEY (pair_id) REFERENCES pairs (id) ON DELETE CASCADE,
  CONSTRAINT marks_member_fk FOREIGN KEY (by_member_id) REFERENCES members (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE question_days (
  pair_id VARCHAR(64) NOT NULL,
  day INT UNSIGNED NOT NULL,
  opened_at VARCHAR(32) NOT NULL,
  replaced TINYINT UNSIGNED NOT NULL DEFAULT 0,
  skipped_at VARCHAR(32) NULL,
  PRIMARY KEY (pair_id, day),
  CONSTRAINT question_days_pair_fk FOREIGN KEY (pair_id) REFERENCES pairs (id) ON DELETE CASCADE,
  CONSTRAINT question_days_replaced_check CHECK (replaced IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE daily_notifications (
  pair_id VARCHAR(64) NOT NULL,
  day INT UNSIGNED NOT NULL,
  member_id VARCHAR(64) NOT NULL,
  sent_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (pair_id, day, member_id),
  CONSTRAINT daily_notifications_pair_fk FOREIGN KEY (pair_id) REFERENCES pairs (id) ON DELETE CASCADE,
  CONSTRAINT daily_notifications_member_fk FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE private_notes (
  pair_id VARCHAR(64) NOT NULL,
  member_id VARCHAR(64) NOT NULL,
  day INT UNSIGNED NOT NULL,
  text TEXT NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (pair_id, member_id, day),
  CONSTRAINT private_notes_pair_fk FOREIGN KEY (pair_id) REFERENCES pairs (id) ON DELETE CASCADE,
  CONSTRAINT private_notes_member_fk FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE diagnostic_events (
  id VARCHAR(64) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  stage VARCHAR(64) NOT NULL,
  error_type VARCHAR(128) NOT NULL,
  error_code VARCHAR(128) NOT NULL,
  message VARCHAR(255) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
