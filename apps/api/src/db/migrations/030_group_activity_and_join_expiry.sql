-- Migration 030: Track group activity for join-code expiry (Req 38.1).
-- (Numbered 030 rather than the next-in-worktree 027 because this repo's
-- shared dev DB already had 027-029 applied by other agents working in
-- parallel worktrees by the time this was written — checked
-- schema_migrations directly to find the true next-free version.)
--
-- Req 38.1: "WHEN a Convoy_Group has been inactive for 24 hours or the group
-- session ends — whichever occurs first — THE App SHALL expire the group
-- join code so that it can no longer be used to join the group."
--
-- The "group session ends" half is already enforced: POST /groups/join and
-- GET /groups/:id/invite-link both reject once convoy_groups.status is no
-- longer 'active'. There was no column tracking "inactivity" at all though,
-- so the 24h-inactivity half of this requirement was never enforced —
-- confirmed by grepping the codebase for any cron/repeatable job, finding
-- none.
--
-- last_activity_at is bumped whenever meaningful group activity happens
-- (location updates, members joining, chat messages — see socket.handler.ts
-- and groups.routes.ts/chat.routes.ts) and a new hourly BullMQ repeatable
-- job (groups/group-expiry.worker.ts) expires the join code — independent
-- of group `status` — once last_activity_at is more than 24h old.
--
-- join_code_active is a separate flag from `status` on purpose: expiring a
-- stale join code per Req 38.1 must NOT also end the group session (kick
-- members, stop location sharing, clear the PTT log, etc.) — that's a
-- distinct, admin-driven action already implemented by POST
-- /groups/:id/end. A still-active session that simply stopped sending
-- traffic for 24h should no longer be *joinable by new members*, but
-- existing members are unaffected.
ALTER TABLE convoy_groups
  ADD COLUMN last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN join_code_active BOOLEAN NOT NULL DEFAULT true;

-- Partial index matching the expiry job's scan query exactly.
CREATE INDEX idx_convoy_groups_expiry_scan
  ON convoy_groups (last_activity_at)
  WHERE status = 'active' AND join_code_active = true;
