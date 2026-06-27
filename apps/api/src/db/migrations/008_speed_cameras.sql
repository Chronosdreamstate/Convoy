CREATE TABLE IF NOT EXISTS speed_cameras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  type VARCHAR(20) NOT NULL DEFAULT 'fixed',
  speed_limit_kph INTEGER,
  direction INTEGER,
  source VARCHAR(20) NOT NULL DEFAULT 'community',
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  upvotes INTEGER NOT NULL DEFAULT 0,
  downvotes INTEGER NOT NULL DEFAULT 0,
  reporter_id UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_speed_cameras_location ON speed_cameras(lat, lng) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_speed_cameras_reporter ON speed_cameras(reporter_id);
