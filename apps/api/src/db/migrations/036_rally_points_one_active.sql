-- Migration 036: at most one ACTIVE rally point per group.
--
-- Context: POST /groups/:id/rally (rally/rally.routes.ts) retired the group's
-- previous rally with an UPDATE and then INSERTed the new one as two separate
-- autocommitted statements. Two Members setting a rally point at the same
-- moment each ran the UPDATE (neither seeing the other's uncommitted INSERT)
-- and then each INSERTed is_active = true, so the group ended up with TWO
-- active rally points: both `rally:set` broadcasts landed, no
-- `rally:cancelled` followed either, and every Member's map carried two rally
-- pins with different riders navigating to different ones. Req 20.3 defines
-- "the active Rally_Point" as singular.
--
-- The route now serialises broadcasters per group (pg_advisory_xact_lock) and
-- does retire+insert in one transaction; this index is the hard guarantee that
-- no future writer can re-introduce the state. idx_rally_points_active already
-- covered exactly these rows — its comment in the route even called it
-- "unique-intent" — so this replaces it with the real thing rather than adding
-- a second index over the same predicate.
--
-- Existing data: any group that already carries more than one active rally
-- (the race this closes) keeps only its newest one active, which is the one
-- the clients' "current rally" lookup (ORDER BY created_at DESC LIMIT 1) has
-- been showing all along. The rows themselves are kept, just deactivated.

UPDATE rally_points rp
SET is_active = false
WHERE rp.is_active = true
  AND EXISTS (
    SELECT 1 FROM rally_points newer
    WHERE newer.group_id = rp.group_id
      AND newer.is_active = true
      AND (newer.created_at, newer.id) > (rp.created_at, rp.id)
  );

DROP INDEX IF EXISTS idx_rally_points_active;

CREATE UNIQUE INDEX IF NOT EXISTS uq_rally_points_one_active
  ON rally_points (group_id)
  WHERE is_active = true;
