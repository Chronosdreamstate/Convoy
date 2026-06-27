-- Migration 016: add bio to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
