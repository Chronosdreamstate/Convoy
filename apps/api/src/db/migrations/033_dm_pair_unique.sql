-- Migration 033: DB-level uniqueness for DM channels (one channel per user pair).
--
-- Context: POST /dm (dm/dm.routes.ts) used a check-then-insert pattern — it
-- SELECTed for an existing type='dm' convoy_groups row shared by the two
-- users and only INSERTed when none was found. Two concurrent POST /dm calls
-- for the same pair could both pass the SELECT and both INSERT, leaving the
-- pair with two DM channels (messages then split across them depending on
-- which groupId each client happened to receive).
--
-- Fix: store the (normalized) participant pair directly on the convoy_groups
-- row and enforce uniqueness with a partial unique index, so concurrent
-- creates converge via INSERT ... ON CONFLICT DO NOTHING + re-select.
--
--  * dm_user_a / dm_user_b are NULL for regular groups; for DM channels they
--    hold the two participants normalized so that dm_user_a < dm_user_b
--    under Postgres uuid ordering (byte-wise, which equals lexicographic
--    order of the canonical lowercase hex string — exactly what the API's
--    normalizeDmPair() helper produces; see dm/dm.routes.ts).
--  * ON DELETE SET NULL (not CASCADE): account deletion currently keeps a DM
--    channel alive for the surviving participant (account.routes.ts transfers
--    admin_id instead of dropping the group), so the pair columns must not
--    block `DELETE FROM users` and must not take the whole conversation down
--    with them. A NULLed pair simply drops out of the partial unique index —
--    correct, since a pair containing a deleted user can never be re-created.
--  * Backfill stamps existing DM channels from convoy_members. If historical
--    duplicates already exist for a pair (the race this migration closes),
--    only the OLDEST channel per pair is stamped; the newer duplicates keep
--    NULL pair columns so the unique index can be created without conflict.
--    They remain reachable by id (message history is preserved) but the
--    stamped channel is the one all future POST /dm lookups converge on.

ALTER TABLE convoy_groups
  ADD COLUMN IF NOT EXISTS dm_user_a UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dm_user_b UUID REFERENCES users(id) ON DELETE SET NULL;

-- Backfill: one row per existing DM channel with exactly two (ever-)members,
-- keeping only the oldest channel per normalized pair (rn = 1).
-- LEAST/GREATEST over a member self-join (uuid comparison operators exist in
-- every supported PG version) rather than MIN/MAX aggregates, because the
-- min(uuid)/max(uuid) aggregates only exist from PostgreSQL 16 onward.
WITH two_member_dms AS (
  SELECT
    g.id,
    g.created_at,
    LEAST(m1.user_id, m2.user_id) AS user_a,
    GREATEST(m1.user_id, m2.user_id) AS user_b
  FROM convoy_groups g
  JOIN convoy_members m1 ON m1.group_id = g.id
  JOIN convoy_members m2 ON m2.group_id = g.id AND m1.user_id < m2.user_id
  WHERE g.type = 'dm'
    AND (SELECT COUNT(DISTINCT user_id) FROM convoy_members WHERE group_id = g.id) = 2
),
ranked AS (
  SELECT
    id,
    user_a,
    user_b,
    ROW_NUMBER() OVER (
      PARTITION BY user_a, user_b
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM two_member_dms
)
UPDATE convoy_groups g
SET dm_user_a = r.user_a,
    dm_user_b = r.user_b
FROM ranked r
WHERE g.id = r.id
  AND r.rn = 1
  AND g.dm_user_a IS NULL;

-- Normalized-pair invariant (strict <: a user cannot DM themselves).
ALTER TABLE convoy_groups
  ADD CONSTRAINT chk_convoy_groups_dm_pair_order
  CHECK (dm_user_a IS NULL OR dm_user_b IS NULL OR dm_user_a < dm_user_b);

-- The uniqueness guarantee itself. Partial: only stamped DM rows participate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_convoy_groups_dm_pair
  ON convoy_groups (dm_user_a, dm_user_b)
  WHERE type = 'dm' AND dm_user_a IS NOT NULL AND dm_user_b IS NOT NULL;
