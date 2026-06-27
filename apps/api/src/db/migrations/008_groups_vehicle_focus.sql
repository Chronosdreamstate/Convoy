-- Migration 008: Add vehicle_focus column to convoy_groups
ALTER TABLE convoy_groups ADD COLUMN IF NOT EXISTS vehicle_focus VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_groups_vehicle_focus ON convoy_groups(vehicle_focus) WHERE vehicle_focus IS NOT NULL;
