CREATE TABLE IF NOT EXISTS group_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  photo_url TEXT NOT NULL,
  caption TEXT,
  drive_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_group_photos_group ON group_photos(group_id, created_at DESC);
