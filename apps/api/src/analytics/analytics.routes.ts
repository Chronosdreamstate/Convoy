import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { rateLimiter } from '../middleware/rateLimiter';

interface AnalyticsEventPayload {
  event: string;
  props: Record<string, unknown>;
  ts: number;
  /**
   * Client-generated dedupe key, stamped when the event is recorded rather
   * than when it is sent, so it survives the client's re-queue-on-failure
   * (see migration 039). Optional: clients predating it send nothing and get a
   * server-generated id, leaving them exactly as deduplicated as before.
   */
  id?: string;
}

interface EventsBody {
  anonymousId: string;
  platform: string;
  events: AnalyticsEventPayload[];
}

// Timestamp sanity bounds: epoch-ms between 2020-01-01 and 2100-01-01.
// Without these, `new Date(ts).toISOString()` throws a RangeError for any
// ts outside ±8.64e15 (e.g. ts: 1e18), turning a bad client payload into an
// unhandled 500.
const TS_MIN = Date.UTC(2020, 0, 1);
const TS_MAX = Date.UTC(2100, 0, 1);

export default async function analyticsRoutes(app: FastifyInstance) {
  // Unauthenticated ingest endpoint — per-IP limiter on top of the global one
  // (anonymous writes to the DB should be throttled harder than 200/min).
  // Skipped in test, mirroring generalLimiter.
  const ingestLimiter =
    process.env.NODE_ENV === 'test'
      ? async (): Promise<void> => { /* skip in test */ }
      : rateLimiter(app.redis, {
          max: 30,
          windowS: 60,
          prefix: 'analytics',
          getKey: (request) => request.ip,
        });

  // POST /analytics/events — ingest a batch of client-side analytics events.
  // Auth is optional: logged-in users get their userId attached for cohort analysis.
  app.post<{ Body: EventsBody }>(
    '/analytics/events',
    {
      preHandler: [ingestLimiter],
      schema: {
        body: {
          type: 'object',
          required: ['anonymousId', 'platform', 'events'],
          properties: {
            anonymousId: { type: 'string', maxLength: 128 },
            platform: { type: 'string', enum: ['ios', 'android', 'web'] },
            events: {
              type: 'array',
              maxItems: 50,
              items: {
                type: 'object',
                required: ['event', 'ts'],
                properties: {
                  event: { type: 'string', maxLength: 64 },
                  props: { type: 'object' },
                  ts: { type: 'number', minimum: TS_MIN, maximum: TS_MAX },
                  id: { type: 'string', minLength: 1, maxLength: 64 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { anonymousId, platform, events } = request.body;

      // Optionally resolve userId from bearer token without requiring auth
      let userId: string | null = null;
      try {
        const decoded = await request.jwtVerify<{ sub: string }>();
        userId = decoded.sub ?? null;
      } catch {
        // Unauthenticated — fine, store as anonymous
      }

      let stored = 0;

      if (events.length > 0) {
        // Single multi-row INSERT instead of one query per event (up to 50
        // round-trips per request on an unauthenticated endpoint).
        const params: unknown[] = [];
        const tuples = events.map((e, i) => {
          const base = i * 7;
          params.push(
            anonymousId,
            userId,
            platform,
            e.event,
            JSON.stringify(e.props ?? {}),
            new Date(e.ts).toISOString(),
            // Clients too old to stamp an id fall back to a per-row uuid,
            // which can never collide — same (un)deduplicated behaviour they
            // have today, rather than a rejected batch.
            e.id ?? randomUUID(),
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6}, $${base + 7})`;
        });

        // A single batch can legitimately arrive twice — the client re-queues
        // it whenever a response is lost — so conflicts are expected, not an
        // error. The conflict target has to name the unique index (migration
        // 039); a bare ON CONFLICT DO NOTHING was what made this a no-op
        // before, since the only other unique constraint is a uuid primary key
        // that never collides.
        //
        // DO NOTHING (unlike DO UPDATE, which raises "cannot affect row a
        // second time") also handles an id repeated WITHIN one batch, so no
        // pre-pass over `events` is needed to collapse those.
        const result = await app.db.query(
          `INSERT INTO analytics_events
             (anonymous_id, user_id, platform, event_name, props, created_at, event_id)
           VALUES ${tuples.join(', ')}
           ON CONFLICT (anonymous_id, event_id) DO NOTHING`,
          params,
        );
        stored = result.rowCount ?? 0;
      }

      // `accepted` stays the number received (the client ignores it, and
      // changing its meaning would misreport to anything that doesn't);
      // `stored` reports how many were actually new.
      return reply.status(200).send({ ok: true, accepted: events.length, stored });
    },
  );
}
