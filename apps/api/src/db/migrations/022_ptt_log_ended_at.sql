-- handlePttEnd (src/socket/socket.handler.ts) stamps ptt_log.ended_at when a
-- transmission finishes and relies on it to detect still-open transmissions,
-- but ptt_log (001_initial_schema.sql) never defined the column — every
-- ptt:end signal was failing with "column ended_at does not exist" and
-- silently swallowed by the socket handler's error catch, so ptt:ended was
-- never broadcast (Req 10.9 media ducking, 10.4 transmitting indicator,
-- 27.1 accurate transmission duration all depend on this).
ALTER TABLE ptt_log ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;

-- Used by handlePttEnd's fallback lookup (most recent still-open transmission
-- for a member when the client's ptt:end arrives before it learned its logId).
CREATE INDEX IF NOT EXISTS idx_ptt_log_open_by_user
  ON ptt_log (group_id, user_id, started_at DESC)
  WHERE ended_at IS NULL;
