import type { FastifyInstance } from 'fastify';
import { rateLimiter } from '../middleware/rateLimiter';

interface AnalyticsEventPayload {
  event: string;
  props: Record<string, unknown>;
  ts: number;
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

      if (events.length > 0) {
        // Single multi-row INSERT instead of one query per event (up to 50
        // round-trips per request on an unauthenticated endpoint).
        const params: unknown[] = [];
        const tuples = events.map((e, i) => {
          const base = i * 6;
          params.push(
            anonymousId,
            userId,
            platform,
            e.event,
            JSON.stringify(e.props ?? {}),
            new Date(e.ts).toISOString(),
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6})`;
        });

        await app.db.query(
          `INSERT INTO analytics_events (anonymous_id, user_id, platform, event_name, props, created_at)
           VALUES ${tuples.join(', ')}
           ON CONFLICT DO NOTHING`,
          params,
        );
      }

      return reply.status(200).send({ ok: true, accepted: events.length });
    },
  );
}
