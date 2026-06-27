-- Migration 015: add name/vehicle_type to vehicles, mods to users
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS vehicle_type TEXT;
ALTER TABLE users    ADD COLUMN IF NOT EXISTS mods TEXT[] NOT NULL DEFAULT '{}';
