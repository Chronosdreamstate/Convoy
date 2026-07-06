-- Migration 024: missing indexes found by cross-referencing live queries in
-- apps/api/src/*/*.routes.ts against the indexes created in 001-022.
--
-- 1. group_photos has no index on user_id. GET /users/me/achievements
--    (users/users.routes.ts, "photos_shared" subquery:
--      SELECT COUNT(*) FROM group_photos WHERE user_id = $1)
--    does a sequential scan of the whole table today (confirmed via EXPLAIN
--    against the live DB) -- the only existing index is
--    idx_group_photos_group(group_id, created_at DESC), which doesn't help a
--    user_id-only filter. group_photos grows unbounded as members post across
--    all groups, so this gets worse over time.
--
-- 2. GET /groups/:id/drives (groups/groups.routes.ts) runs:
--      SELECT ... FROM drive_history WHERE group_id = $1
--      ORDER BY started_at DESC LIMIT 100
--    007_performance_indexes.sql added idx_drive_history_group_started, but
--    as a *partial* index (WHERE group_id IS NOT NULL AND ended_at IS NOT
--    NULL) intended for a different query. This query has no `ended_at IS
--    NOT NULL` predicate, so Postgres cannot prove the partial index's
--    condition is satisfied and falls back to idx_drive_history_group_id
--    (unsorted) plus an explicit Sort step (confirmed via EXPLAIN against the
--    live DB). Adding a non-partial composite index lets this query -- and
--    any other group_id + chronological-order lookup -- use an index-only
--    sort regardless of ended_at.

CREATE INDEX IF NOT EXISTS idx_group_photos_user
  ON group_photos (user_id);

CREATE INDEX IF NOT EXISTS idx_drive_history_group_started_all
  ON drive_history (group_id, started_at DESC);
