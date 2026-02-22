-- CHKN Postgres schema (shared DB, isolated schema)
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS chkn;
SET search_path TO chkn, public;

CREATE TABLE IF NOT EXISTS matches (
  match_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mode       TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'matches_mode_chk'
  ) THEN
    ALTER TABLE matches
      ADD CONSTRAINT matches_mode_chk
      CHECK (mode IN ('CHICKEN_RUN','FIVE_KAMP','BLACKJACK_ONLY'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'matches_status_chk'
  ) THEN
    ALTER TABLE matches
      ADD CONSTRAINT matches_status_chk
      CHECK (status IN ('CREATED','RUNNING','COMPLETED','CANCELLED'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION chkn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_matches_updated_at'
  ) THEN
    CREATE TRIGGER trg_matches_updated_at
    BEFORE UPDATE ON matches
    FOR EACH ROW EXECUTE FUNCTION chkn_set_updated_at();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS match_events (
  event_id  BIGSERIAL PRIMARY KEY,
  match_id  UUID NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
  seq       INT NOT NULL,
  type      TEXT NOT NULL,
  payload   JSONB NOT NULL DEFAULT '{}'::jsonb,
  ts        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_match_events_match_seq
  ON match_events(match_id, seq);

CREATE INDEX IF NOT EXISTS idx_match_events_match_id
  ON match_events(match_id);

CREATE TABLE IF NOT EXISTS match_snapshots (
  match_id   UUID NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
  seq        INT NOT NULL,
  state_json JSONB NOT NULL,
  ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (match_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_match_snapshots_match_id
  ON match_snapshots(match_id);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id      TEXT PRIMARY KEY,
  birth_date   DATE NOT NULL,
  birth_time   TIME NULL,
  unknown_time BOOLEAN NOT NULL DEFAULT FALSE,
  birth_place  TEXT NOT NULL,
  birth_lat    NUMERIC(9,6) NULL,
  birth_lng    NUMERIC(9,6) NULL,
  tz_name      TEXT NULL,
  tz_offset_minutes INT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_profiles_time_chk'
  ) THEN
    ALTER TABLE user_profiles
      ADD CONSTRAINT user_profiles_time_chk
      CHECK (
        (unknown_time = TRUE AND birth_time IS NULL) OR
        (unknown_time = FALSE AND birth_time IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='chkn' AND table_name='user_profiles' AND column_name='tz_name'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN tz_name TEXT NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='chkn' AND table_name='user_profiles' AND column_name='tz_offset_minutes'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN tz_offset_minutes INT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_user_profiles_updated_at'
  ) THEN
    CREATE TRIGGER trg_user_profiles_updated_at
    BEFORE UPDATE ON user_profiles
    FOR EACH ROW EXECUTE FUNCTION chkn_set_updated_at();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS user_avatars (
  user_id          TEXT PRIMARY KEY,
  avatar_mime_type TEXT NOT NULL,
  avatar_data      BYTEA NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_user_avatars_updated_at'
  ) THEN
    CREATE TRIGGER trg_user_avatars_updated_at
    BEFORE UPDATE ON user_avatars
    FOR EACH ROW EXECUTE FUNCTION chkn_set_updated_at();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS birth_charts (
  chart_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL REFERENCES user_profiles(user_id) ON DELETE CASCADE,
  input_json  JSONB NOT NULL,
  result_json JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_birth_charts_user_id
  ON birth_charts(user_id);

CREATE TABLE IF NOT EXISTS profile_insights (
  insight_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT NOT NULL REFERENCES user_profiles(user_id) ON DELETE CASCADE,
  summary_json     JSONB NOT NULL,
  astrology_json   JSONB NOT NULL,
  human_design_json JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profile_insights_user_id
  ON profile_insights(user_id);

CREATE TABLE IF NOT EXISTS user_tarot_daily (
  user_id          TEXT NOT NULL REFERENCES user_profiles(user_id) ON DELETE CASCADE,
  draw_date        DATE NOT NULL,
  card_number      INT NOT NULL,
  card_name        TEXT NOT NULL,
  orientation      TEXT NOT NULL,
  image_url        TEXT NOT NULL,
  summary          TEXT NOT NULL,
  upright_meaning  TEXT NOT NULL,
  reversed_meaning TEXT NOT NULL,
  more_info_url    TEXT NOT NULL,
  drawn_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, draw_date)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_tarot_daily_orientation_chk'
  ) THEN
    ALTER TABLE user_tarot_daily
      ADD CONSTRAINT user_tarot_daily_orientation_chk
      CHECK (orientation IN ('upright', 'reversed'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_user_tarot_daily_updated_at'
  ) THEN
    CREATE TRIGGER trg_user_tarot_daily_updated_at
    BEFORE UPDATE ON user_tarot_daily
    FOR EACH ROW EXECUTE FUNCTION chkn_set_updated_at();
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_tarot_daily_user
  ON user_tarot_daily(user_id, draw_date DESC);

RESET search_path;

-- Permissions
-- prod DB: sputnet_app (role: yatzy_user)
-- dev  DB: sputnet_app_dev (role: yatzy_devusr)
GRANT USAGE ON SCHEMA chkn TO yatzy_user, yatzy_devusr;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA chkn TO yatzy_user, yatzy_devusr;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA chkn TO yatzy_user, yatzy_devusr;

ALTER DEFAULT PRIVILEGES IN SCHEMA chkn
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO yatzy_user, yatzy_devusr;
ALTER DEFAULT PRIVILEGES IN SCHEMA chkn
  GRANT USAGE, SELECT ON SEQUENCES TO yatzy_user, yatzy_devusr;

COMMIT;
