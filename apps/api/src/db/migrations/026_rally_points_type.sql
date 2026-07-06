-- The mobile client's RallyService.broadcastRally always sends a `type`
-- (waypoint/meetup/fuel/rest/photo — used to pick the marker emoji via
-- RALLY_EMOJI) and the client's RallyPoint interface declares `type` as
-- required, but rally_points (001_initial_schema.sql) never had a column
-- for it, so the server silently dropped the value: never persisted, never
-- returned from POST /groups/:id/rally, and never included in the rally:set
-- broadcast (Req 20.1-20.3).
ALTER TABLE rally_points ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'waypoint';

ALTER TABLE rally_points
  ADD CONSTRAINT rally_points_type_check
  CHECK (type IN ('waypoint', 'meetup', 'fuel', 'rest', 'photo'));
