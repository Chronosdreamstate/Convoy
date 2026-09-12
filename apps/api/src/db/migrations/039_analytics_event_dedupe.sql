-- Migration 039: make analytics ingest actually idempotent.
--
-- Context: POST /analytics/events ended its multi-row INSERT with
-- `ON CONFLICT DO NOTHING`, which reads as dedupe but is a guaranteed no-op
-- here — analytics_events (migration 008) has exactly one unique constraint,
-- the primary key on `id UUID DEFAULT gen_random_uuid()`, and a freshly
-- generated uuid never collides. There was nothing for the clause to catch.
--
-- That matters because the client delivers this batch at-least-once. The app's
-- AnalyticsService.flush() splices up to 20 events off its queue, POSTs them,
-- and on ANY failure puts them back:
--
--     catch { this.queue = [...batch, ...this.queue] }
--
-- A request that reached the API and committed but whose response was lost
-- (dead zone, timeout — the normal case for a driving app) therefore gets sent
-- again, and every event in it is counted twice. Same outcome if the app is
-- killed between a successful POST and the AsyncStorage write that records the
-- batch as sent: the pre-splice queue is still on disk and replays at launch.
-- apiClient deliberately does NOT auto-retry POSTs, so this app-level re-queue
-- is the whole of the exposure — but it is enough to inflate exactly the
-- counts (convoy_started, group_created, ptt_used) the table exists to report.
--
-- Fix: the client now stamps each event with an id at track() time — stable
-- across re-queues, because it is generated once when the event is recorded,
-- not when it is sent — and that id becomes the dedupe key.
--
--  * event_id is NOT NULL so it can carry a plain (not partial) unique index,
--    which keeps the ON CONFLICT inference in the route straightforward.
--    Existing rows backfill from their primary key, which is already unique;
--    clients too old to send an id get a server-generated uuid, leaving them
--    exactly as deduplicated as they are today (i.e. not at all) rather than
--    rejecting their writes.
--  * Uniqueness is scoped to (anonymous_id, event_id), not event_id alone.
--    anonymous_id is client-supplied on an unauthenticated endpoint, so a
--    global unique index would let one install suppress another's events by
--    replaying their ids. Per-install scoping confines any collision — honest
--    or malicious — to the install that sent it.

ALTER TABLE analytics_events
  ADD COLUMN IF NOT EXISTS event_id TEXT;

-- Backfill from the primary key: already unique, so the index below can be
-- created without conflict, and these rows keep their current semantics.
UPDATE analytics_events SET event_id = id::text WHERE event_id IS NULL;

ALTER TABLE analytics_events
  ALTER COLUMN event_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_analytics_events_anon_event
  ON analytics_events (anonymous_id, event_id);
