-- Migration 007: Additional performance indexes
-- Fills gaps left by 001-006 migrations.
-- All statements are IF NOT EXISTS / idempotent.

-- ptt_callsign trigram search — 002 added display_name trgm but not callsign.
-- Powers GET /users/search?q= callsign matching added in Wave 6.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_users_callsign_trgm
  ON users USING GIN (ptt_callsign gin_trgm_ops)
  WHERE ptt_callsign IS NOT NULL;

-- event_rsvps: lookup all events a specific user RSVPed to (profile / "my events" view).
-- 006 only added idx_rsvp_event on event_id; user_id lookup was missing.
CREATE INDEX IF NOT EXISTS idx_rsvp_user
  ON event_rsvps (user_id, status);

-- notification_history: unread-only partial index for the badge count query.
-- 005 added (user_id, created_at DESC) but without the partial predicate,
-- so COUNT(*) WHERE read_at IS NULL still scans all rows per user.
CREATE INDEX IF NOT EXISTS idx_notif_history_user_unread
  ON notification_history (user_id, created_at DESC)
  WHERE read_at IS NULL;

-- drive_history by group sorted chronologically — used by GET /groups/:id/drives.
-- 001 has idx_drive_history_group_id but it is unsorted; this composite avoids a sort step.
CREATE INDEX IF NOT EXISTS idx_drive_history_group_started
  ON drive_history (group_id, started_at DESC)
  WHERE group_id IS NOT NULL AND ended_at IS NOT NULL;

-- group_events: created_by lookup (admin "my events" panel).
CREATE INDEX IF NOT EXISTS idx_group_events_created_by
  ON group_events (created_by, scheduled_for DESC);
