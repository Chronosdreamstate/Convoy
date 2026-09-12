-- Migration 037: group_join_requests.resolved_by ON DELETE SET NULL.
--
-- Context: migration 023 swept the FKs that blocked DELETE /account
-- (account/account.routes.ts) as of migration 022. group_join_requests
-- (migration 027) landed afterwards and repeated the same mistake: user_id
-- cascades, but resolved_by — stamped with the ADMIN's id whenever they
-- approve or reject a request (groups/joinRequests.routes.ts, the
-- `SET status = 'approved', resolved_at = now(), resolved_by = $1` updates) —
-- was declared with no ON DELETE action at all.
--
-- Consequence: an admin of an invite-only group who has ever tapped Approve or
-- Reject on a join request cannot delete their account. `DELETE FROM users`
-- raises
--   "update or delete on table users violates foreign key constraint
--    group_join_requests_resolved_by_fkey on table group_join_requests"
-- the handler's transaction rolls back, and Settings → Delete Account returns
-- 500 — every time, forever. (Reproduced against the live DB; see
-- account/account.deletion.live.test.ts.) The group_join_requests rows are not
-- cleaned up anywhere else either: they only disappear with the group, and the
-- group survives account deletion whenever it has another member.
--
-- Fix: SET NULL, matching group_events.created_by (023) and
-- speed_cameras.reporter_id (021). The request row belongs to the REQUESTER
-- (whose user_id already cascades) and is part of the group's history, so it
-- must not be destroyed with the admin who happened to action it — it just
-- loses the "resolved by" attribution, which the read path already types as
-- nullable (groups/joinRequests.routes.ts `resolved_by: string | null`).

ALTER TABLE group_join_requests DROP CONSTRAINT IF EXISTS group_join_requests_resolved_by_fkey;
ALTER TABLE group_join_requests
  ADD CONSTRAINT group_join_requests_resolved_by_fkey
  FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL;
