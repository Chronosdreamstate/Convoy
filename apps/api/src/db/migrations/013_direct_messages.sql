ALTER TABLE convoy_groups
  ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'group' CHECK (type IN ('group', 'dm'));

CREATE INDEX IF NOT EXISTS idx_convoy_groups_type ON convoy_groups(type) WHERE type = 'dm';
