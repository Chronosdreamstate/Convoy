-- Migration 031: Opt-in "nearby strangers" discovery
-- Adds a personal opt-in visibility flag and an approximate-location presence
-- table used by GET /api/v1/nearby (PostGIS ST_DWithin).
--
-- Privacy: nearby_presence stores ONLY a coarse, server-snapped location.
-- Exact device coordinates are never written here and never leave the server
-- for nearby queries.

-- Opt-in flag: is this user discoverable by / visible to nearby strangers?
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS visible_to_nearby BOOLEAN NOT NULL DEFAULT false;

-- Approximate presence for nearby discovery. One row per user; upserted while
-- the user is opted-in and actively using nearby.
CREATE TABLE IF NOT EXISTS nearby_presence (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  approx_location GEOGRAPHY(Point, 4326) NOT NULL,  -- coarse, ~110m snapped grid
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- GIST spatial index for fast ST_DWithin lookups.
CREATE INDEX IF NOT EXISTS nearby_presence_location_idx
  ON nearby_presence USING GIST (approx_location);

-- Staleness filter support (only surface recently-active users).
CREATE INDEX IF NOT EXISTS idx_nearby_presence_updated_at
  ON nearby_presence (updated_at);
