ALTER TABLE group_messages
  ADD COLUMN IF NOT EXISTS type      TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'voice')),
  ADD COLUMN IF NOT EXISTS audio_url TEXT;
