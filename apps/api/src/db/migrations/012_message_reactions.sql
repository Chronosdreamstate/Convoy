CREATE TABLE IF NOT EXISTS message_reactions (
  message_id  UUID NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id)          ON DELETE CASCADE,
  emoji       TEXT NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 8),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id);
