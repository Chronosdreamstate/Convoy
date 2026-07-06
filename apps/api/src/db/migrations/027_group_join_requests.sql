-- Invite-only groups (convoy_groups.access_type = 'invite_only') had no working
-- join path at all: both POST /groups/join (by code) and POST /groups/:id/members
-- (direct) return 403 for invite-only groups, with no other route to get in.
-- This adds a simple admin-approval request flow, mirroring the existing
-- friend-request accept/decline pattern (see friendships table / friends.routes.ts).
CREATE TABLE group_join_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     UUID NOT NULL REFERENCES convoy_groups(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  resolved_by  UUID REFERENCES users(id)
);

CREATE INDEX idx_group_join_requests_group_id ON group_join_requests (group_id);
CREATE INDEX idx_group_join_requests_user_id ON group_join_requests (user_id);

-- Only one *pending* request per (group, user) at a time — a user whose
-- request was rejected (or approved, then later left) is free to request
-- again, so this is a partial index rather than a plain UNIQUE constraint.
CREATE UNIQUE INDEX idx_group_join_requests_pending_unique
  ON group_join_requests (group_id, user_id) WHERE status = 'pending';
