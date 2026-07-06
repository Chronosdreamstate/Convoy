-- GET /users/me/achievements (src/users/users.routes.ts) hardcoded sos_hero,
-- ptt_master, and waypoint_setter to progress: 0, unlocked: false forever —
-- no counters existed anywhere to track responding to an SOS alert, or
-- waypoints added (PTT usage is derived directly from ptt_log at read time
-- instead, since ptt_log already has one row per transmission).
--
-- Minimal generic key/count table rather than one column per stat, so future
-- achievement counters don't each need their own migration.
CREATE TABLE IF NOT EXISTS user_stat_counters (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stat_key   TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, stat_key)
);
