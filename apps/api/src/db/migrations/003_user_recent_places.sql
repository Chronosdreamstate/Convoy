-- user_recent_places: server-side recent destination sync (mirrors mobile SecureStore)
-- Capped at 20 per user; upsert on (user_id, name, address) updates visited_at.

CREATE TABLE IF NOT EXISTS user_recent_places (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  place_id    TEXT,                             -- Nominatim place_id (nullable for manual pins)
  name        TEXT        NOT NULL,
  address     TEXT        NOT NULL DEFAULT '',
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  visited_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name, address)
);

CREATE INDEX idx_user_recent_places_user_visited
  ON user_recent_places (user_id, visited_at DESC);
