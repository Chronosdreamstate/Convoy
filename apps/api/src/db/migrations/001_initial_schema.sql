-- Migration 001: Initial schema
-- Creates all core tables for the CONVOY application.
-- Requires PostgreSQL 16 + PostGIS 3.

-- Enable PostGIS extension
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  TEXT NOT NULL,
  phone_number  TEXT UNIQUE,
  email         TEXT UNIQUE,
  avatar_url    TEXT,
  ptt_callsign  TEXT,
  privacy       TEXT NOT NULL DEFAULT 'open' CHECK (privacy IN ('open', 'invite_only')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_phone ON users (phone_number) WHERE phone_number IS NOT NULL;
CREATE INDEX idx_users_email ON users (email) WHERE email IS NOT NULL;

-- ---------------------------------------------------------------------------
-- auth_providers
-- ---------------------------------------------------------------------------
CREATE TABLE auth_providers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL CHECK (provider IN ('phone', 'email', 'apple', 'google')),
  provider_id TEXT NOT NULL,
  UNIQUE (provider, provider_id)
);

CREATE INDEX idx_auth_providers_user_id ON auth_providers (user_id);

-- ---------------------------------------------------------------------------
-- devices
-- ---------------------------------------------------------------------------
CREATE TABLE devices (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  push_token TEXT NOT NULL,
  platform   TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_devices_user_id ON devices (user_id);

-- ---------------------------------------------------------------------------
-- vehicles  (Garage)
-- ---------------------------------------------------------------------------
CREATE TABLE vehicles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year       SMALLINT,
  make       TEXT,
  model      TEXT,
  color      TEXT,
  photo_url  TEXT,
  is_active  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_vehicles_user_id ON vehicles (user_id);

-- ---------------------------------------------------------------------------
-- friendships
-- ---------------------------------------------------------------------------
CREATE TABLE friendships (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'blocked')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (requester_id, addressee_id)
);

CREATE INDEX idx_friendships_requester_id ON friendships (requester_id);
CREATE INDEX idx_friendships_addressee_id ON friendships (addressee_id);
CREATE INDEX idx_friendships_status ON friendships (status);

-- ---------------------------------------------------------------------------
-- convoy_groups
-- ---------------------------------------------------------------------------
CREATE TABLE convoy_groups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  join_code       CHAR(6) NOT NULL UNIQUE,
  admin_id        UUID NOT NULL REFERENCES users(id),
  access_type     TEXT NOT NULL DEFAULT 'open' CHECK (access_type IN ('open', 'invite_only')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  gap_threshold_m INTEGER NOT NULL DEFAULT 3219,  -- 2 miles in metres
  ptt_max_seconds SMALLINT NOT NULL DEFAULT 30,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ
);

CREATE INDEX idx_convoy_groups_admin_id ON convoy_groups (admin_id);
CREATE INDEX idx_convoy_groups_join_code ON convoy_groups (join_code);
CREATE INDEX idx_convoy_groups_status ON convoy_groups (status);

-- ---------------------------------------------------------------------------
-- convoy_members
-- ---------------------------------------------------------------------------
CREATE TABLE convoy_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   UUID NOT NULL REFERENCES convoy_groups(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at    TIMESTAMPTZ,
  is_muted   BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (group_id, user_id)
);

CREATE INDEX idx_convoy_members_group_id ON convoy_members (group_id);
CREATE INDEX idx_convoy_members_user_id ON convoy_members (user_id);
CREATE INDEX idx_convoy_members_active ON convoy_members (group_id) WHERE left_at IS NULL;

-- ---------------------------------------------------------------------------
-- ptt_channels
-- ---------------------------------------------------------------------------
CREATE TABLE ptt_channels (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES convoy_groups(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  is_all   BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (group_id, name)
);

CREATE INDEX idx_ptt_channels_group_id ON ptt_channels (group_id);

-- ---------------------------------------------------------------------------
-- ptt_channel_members
-- ---------------------------------------------------------------------------
CREATE TABLE ptt_channel_members (
  channel_id UUID NOT NULL REFERENCES ptt_channels(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX idx_ptt_channel_members_user_id ON ptt_channel_members (user_id);
CREATE INDEX idx_ptt_channel_members_channel_id ON ptt_channel_members (channel_id);

-- ---------------------------------------------------------------------------
-- ptt_log
-- ---------------------------------------------------------------------------
CREATE TABLE ptt_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID NOT NULL REFERENCES convoy_groups(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id),
  channel_id  UUID REFERENCES ptt_channels(id),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Entire table is wiped for a group when session ends.

CREATE INDEX idx_ptt_log_group_id ON ptt_log (group_id);
CREATE INDEX idx_ptt_log_started_at ON ptt_log (group_id, started_at ASC);

-- ---------------------------------------------------------------------------
-- hazard_reports  (requires PostGIS)
-- ---------------------------------------------------------------------------
CREATE TABLE hazard_reports (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id        UUID NOT NULL REFERENCES users(id),
  hazard_type        TEXT NOT NULL,
  location           GEOGRAPHY(Point, 4326) NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'dismissed')),
  expires_at         TIMESTAMPTZ NOT NULL,
  confirmation_count INTEGER NOT NULL DEFAULT 0,
  dismissal_count    INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- GIST index for fast spatial lookups (ST_DWithin, etc.)
CREATE INDEX hazard_location_idx ON hazard_reports USING GIST (location);
CREATE INDEX idx_hazard_reports_status ON hazard_reports (status);
CREATE INDEX idx_hazard_reports_expires_at ON hazard_reports (expires_at) WHERE status = 'active';
CREATE INDEX idx_hazard_reports_reporter_id ON hazard_reports (reporter_id);

-- ---------------------------------------------------------------------------
-- hazard_votes
-- ---------------------------------------------------------------------------
CREATE TABLE hazard_votes (
  hazard_id  UUID NOT NULL REFERENCES hazard_reports(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id),
  vote       TEXT NOT NULL CHECK (vote IN ('confirm', 'dismiss')),
  voted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hazard_id, user_id)
);

CREATE INDEX idx_hazard_votes_user_id ON hazard_votes (user_id);

-- ---------------------------------------------------------------------------
-- drive_history
-- ---------------------------------------------------------------------------
CREATE TABLE drive_history (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id         UUID REFERENCES convoy_groups(id),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_trace      JSONB NOT NULL,          -- GeoJSON LineString of GPS coordinates
  distance_m       INTEGER NOT NULL,
  duration_s       INTEGER NOT NULL,
  avg_speed_kph    NUMERIC(5,2),
  top_speed_kph    NUMERIC(5,2),
  member_count     SMALLINT NOT NULL DEFAULT 1,
  started_at       TIMESTAMPTZ NOT NULL,
  ended_at         TIMESTAMPTZ NOT NULL,
  summary_card_url TEXT,
  synced_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_drive_history_user_id ON drive_history (user_id);
CREATE INDEX idx_drive_history_ended_at ON drive_history (user_id, ended_at DESC);
CREATE INDEX idx_drive_history_group_id ON drive_history (group_id) WHERE group_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- rally_points
-- ---------------------------------------------------------------------------
CREATE TABLE rally_points (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id       UUID NOT NULL REFERENCES convoy_groups(id) ON DELETE CASCADE,
  broadcaster_id UUID NOT NULL REFERENCES users(id),
  location       GEOGRAPHY(Point, 4326) NOT NULL,
  address        TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rally_points_group_id ON rally_points (group_id);
CREATE INDEX idx_rally_points_active ON rally_points (group_id) WHERE is_active = true;

-- ---------------------------------------------------------------------------
-- user_settings
-- ---------------------------------------------------------------------------
CREATE TABLE user_settings (
  user_id                  UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hazard_alert_distance_m  INTEGER NOT NULL DEFAULT 805,   -- 0.5 miles
  ptt_max_seconds          SMALLINT NOT NULL DEFAULT 30,
  tile_cache_limit_mb      INTEGER NOT NULL DEFAULT 500,
  scenic_routing           BOOLEAN NOT NULL DEFAULT false,
  map_style                TEXT NOT NULL DEFAULT 'standard',
  notif_hazard             BOOLEAN NOT NULL DEFAULT true,
  notif_group_events       BOOLEAN NOT NULL DEFAULT true,
  notif_friend_requests    BOOLEAN NOT NULL DEFAULT true,
  notif_navigation         BOOLEAN NOT NULL DEFAULT true
);
