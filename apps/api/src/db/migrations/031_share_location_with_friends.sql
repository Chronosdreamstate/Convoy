-- Groupless friend-level live location sharing.
--
-- Location sharing previously only existed within an active convoy group
-- (Req 8 — group members see each other via Redis loc:<groupId>:<userId>
-- cache + socket broadcast to the group room). This adds a separate,
-- groupless opt-in: a user can choose to share their live location with
-- their accepted friends regardless of whether either party is in a convoy.
--
-- Defaults to false (opt-in, off by default) to match the existing privacy
-- posture of every other notif_*/scenic_routing toggle on this table.
--
-- See GET /api/v1/friends/locations (src/friends/friends.routes.ts) and the
-- groupless location:update path in src/socket/socket.handler.ts, which
-- caches to Redis under loc:friend:<userId> (short TTL, no group required)
-- only when this flag is true. Toggling this off via PATCH /api/v1/settings
-- also proactively deletes that Redis key so cached data can't outlive the
-- opt-out (see src/settings/settings.routes.ts).
ALTER TABLE user_settings
  ADD COLUMN share_location_with_friends BOOLEAN NOT NULL DEFAULT false;
