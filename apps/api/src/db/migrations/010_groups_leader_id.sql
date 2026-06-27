-- Add leader_id to convoy_groups to track the current lead car
ALTER TABLE convoy_groups ADD COLUMN IF NOT EXISTS leader_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_convoy_groups_leader ON convoy_groups(leader_id) WHERE leader_id IS NOT NULL;
