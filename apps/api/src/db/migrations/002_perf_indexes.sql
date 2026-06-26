-- Migration 002: Performance indexes
-- Adds pg_trgm support for fast ILIKE user search and composite indexes for
-- common filtered queries that would otherwise do sequential scans at scale.

-- pg_trgm enables GIN indexes on text columns for efficient ILIKE / similarity queries.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN index on users.display_name so GET /api/v1/users/search?q= uses the index
-- instead of a sequential scan. Covers ILIKE '%q%' patterns (requires pg_trgm).
CREATE INDEX IF NOT EXISTS idx_users_display_name_trgm
  ON users USING GIN (display_name gin_trgm_ops);

-- Composite index for the group discover endpoint:
-- SELECT ... WHERE status = 'active' AND access_type = 'open' ORDER BY created_at DESC
-- The existing idx_convoy_groups_status only covers status; this covers both columns.
CREATE INDEX IF NOT EXISTS idx_convoy_groups_active_open
  ON convoy_groups (status, access_type, created_at DESC)
  WHERE status = 'active' AND access_type = 'open';

-- Partial index for active friendships lookup (GET /friends and block checks)
-- Covers: WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)
CREATE INDEX IF NOT EXISTS idx_friendships_accepted_requester
  ON friendships (requester_id, addressee_id)
  WHERE status = 'accepted';

CREATE INDEX IF NOT EXISTS idx_friendships_accepted_addressee
  ON friendships (addressee_id, requester_id)
  WHERE status = 'accepted';

-- Composite index for ptt_log chronological read per group (GET /groups/:id/ptt-log)
-- Covers: WHERE group_id = $1 ORDER BY started_at ASC
-- The existing idx_ptt_log_started_at already covers this — no addition needed.

-- Composite index for hazard proximity queries:
-- ST_DWithin checks filter on status = 'active' first; pairing with the GIST
-- index lets Postgres eliminate expired/dismissed rows before the spatial join.
CREATE INDEX IF NOT EXISTS idx_hazard_reports_active_location
  ON hazard_reports USING GIST (location)
  WHERE status = 'active';
