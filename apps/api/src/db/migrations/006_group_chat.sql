CREATE TABLE IF NOT EXISTS group_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID NOT NULL REFERENCES convoy_groups(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text        TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 500),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_group_messages_group_cursor ON group_messages(group_id, created_at DESC, id DESC);
