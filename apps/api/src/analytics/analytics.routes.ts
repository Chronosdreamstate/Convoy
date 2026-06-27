import type { FastifyInstance } from 'fastify';

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

export default async function analyticsRoutes(app: FastifyInstance) {
  // POST /analytics/events — ingest a batch of client-side analytics events.
  // Auth is optional: logged-in users get their userId attached for cohort analysis.
  app.post<{ Body: EventsBody }>(
    '/analytics/events',
    {
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
                  ts: { type: 'number' },
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

      const db = app.db;
      const values = events.map((e) => ({
        anonymous_id: anonymousId,
        user_id: userId,
        platform,
        event_name: e.event,
        props: JSON.stringify(e.props ?? {}),
        created_at: new Date(e.ts).toISOString(),
      }));

      if (values.length > 0) {
        await Promise.all(
          values.map((v) =>
            db.query(
              `INSERT INTO analytics_events (anonymous_id, user_id, platform, event_name, props, created_at)
               VALUES ($1, $2, $3, $4, $5::jsonb, $6)
               ON CONFLICT DO NOTHING`,
              [v.anonymous_id, v.user_id, v.platform, v.event_name, v.props, v.created_at],
            ),
          ),
        );
      }

      return reply.status(200).send({ ok: true, accepted: values.length });
    },
  );
}
