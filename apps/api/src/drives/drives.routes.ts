/**
 * Drive history API
 * Requirements: 19.2–19.6, 42.3
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';
import { env } from '../config/env';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RawDriveRow {
  id: string;
  user_id: string;
  group_id: string | null;
  route_trace: { type: string; coordinates: [number, number][] };
  distance_m: number;
  duration_s: number;
  avg_speed_kph: number | null;
  top_speed_kph: number | null;
  member_count: number;
  started_at: Date;
  ended_at: Date;
  summary_card_url: string | null;
  created_at: Date;
}

export interface DriveResponse {
  id: string;
  userId: string;
  groupId: string | null;
  routeTrace: { type: string; coordinates: [number, number][] };
  distanceM: number;
  durationS: number;
  avgSpeedKph: number | null;
  topSpeedKph: number | null;
  memberCount: number;
  startedAt: string;
  endedAt: string;
  summaryCardUrl: string | null;
  createdAt: string;
}

export const REQUIRED_DRIVE_FIELDS = [
  'id', 'userId', 'routeTrace', 'distanceM', 'durationS',
  'memberCount', 'startedAt', 'endedAt',
] as const;

// ---------------------------------------------------------------------------
// Pure helpers — exported for property testing
// ---------------------------------------------------------------------------

/** Property 31: all required fields are non-null. */
export function hasAllRequiredFields(drive: Partial<DriveResponse>): boolean {
  return REQUIRED_DRIVE_FIELDS.every((f) => {
    const v = drive[f as keyof DriveResponse];
    return v !== undefined && v !== null;
  });
}

/** Property 32: each drive's endedAt is >= the next one (DESC order). */
export function isDrivesSortedDesc(drives: Pick<DriveResponse, 'endedAt'>[]): boolean {
  for (let i = 1; i < drives.length; i++) {
    if (drives[i].endedAt > drives[i - 1].endedAt) return false;
  }
  return true;
}

export function serializeDriveRow(row: RawDriveRow): DriveResponse {
  return {
    id: row.id,
    userId: row.user_id,
    groupId: row.group_id,
    routeTrace: row.route_trace,
    distanceM: row.distance_m,
    durationS: row.duration_s,
    avgSpeedKph: row.avg_speed_kph,
    topSpeedKph: row.top_speed_kph,
    memberCount: row.member_count,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at.toISOString(),
    summaryCardUrl: row.summary_card_url,
    createdAt: row.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Summary-card URL builder (Mapbox Static Images API)
// ---------------------------------------------------------------------------

/**
 * Builds a token-free Mapbox Static Images URL for DB storage.
 * Callers must append `&access_token=<token>` before returning to clients.
 */
export function buildSummaryCardUrl(coordinates: [number, number][]): string {
  if (coordinates.length === 0) return '';

  const lineString = { type: 'LineString', coordinates };
  const encoded = encodeURIComponent(JSON.stringify(lineString));
  const overlay = `geojson(${encoded})`;

  return (
    `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${overlay}` +
    `/auto/600x338?padding=40`
  );
}

/** Attaches the current Mapbox token to a stored token-free summary card URL. */
export function hydrateSummaryCardUrl(url: string | null, accessToken: string): string | null {
  if (!url) return null;
  if (url.includes('access_token=')) return url; // already hydrated (legacy rows)
  return `${url}&access_token=${accessToken}`;
}

// ---------------------------------------------------------------------------
// Request body schema
// ---------------------------------------------------------------------------

const lineStringSchema = z.object({
  type: z.literal('LineString'),
  coordinates: z.array(z.tuple([z.number(), z.number()])).min(1),
});

const driveBodySchema = z.object({
  groupId: z.string().uuid().nullable().optional(),
  routeTrace: lineStringSchema,
  distanceM: z.number().int().min(0),
  durationS: z.number().int().min(0),
  avgSpeedKph: z.number().min(0).nullable().optional(),
  topSpeedKph: z.number().min(0).nullable().optional(),
  memberCount: z.number().int().min(1).default(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
}).refine(
  (d) => new Date(d.endedAt) >= new Date(d.startedAt),
  { message: 'endedAt must be >= startedAt', path: ['endedAt'] },
);

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

const drivesRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /drives ───────────────────────────────────────────────────────────
  fastify.get('/drives', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const query = (request.query as { page?: string; limit?: string });
    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(query.limit ?? '20', 10) || 20));
    const offset = (page - 1) * limit;

    const result = await fastify.db.query<RawDriveRow>(
      `SELECT id, user_id, group_id, route_trace, distance_m, duration_s,
              avg_speed_kph, top_speed_kph, member_count,
              started_at, ended_at, summary_card_url, created_at
       FROM drive_history
       WHERE user_id = $1
       ORDER BY ended_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );

    const countResult = await fastify.db.query<{ total: string }>(
      'SELECT COUNT(*) AS total FROM drive_history WHERE user_id = $1',
      [userId],
    );
    const total = parseInt(countResult.rows[0].total, 10);

    return reply.send({
      drives: result.rows.map((row) => ({
        ...serializeDriveRow(row),
        summaryCardUrl: hydrateSummaryCardUrl(row.summary_card_url, env.MAPBOX_API_TOKEN),
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  });

  // ── GET /drives/:id ───────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/drives/:id', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params;

    const result = await fastify.db.query<RawDriveRow>(
      `SELECT id, user_id, group_id, route_trace, distance_m, duration_s,
              avg_speed_kph, top_speed_kph, member_count,
              started_at, ended_at, summary_card_url, created_at
       FROM drive_history WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    if (result.rows.length === 0) return reply.status(404).send({ error: 'Drive not found' });
    const row = result.rows[0];
    return reply.send({
      ...serializeDriveRow(row),
      summaryCardUrl: hydrateSummaryCardUrl(row.summary_card_url, env.MAPBOX_API_TOKEN),
    });
  });

  // ── POST /drives ──────────────────────────────────────────────────────────
  fastify.post('/drives', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const parsed = driveBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.flatten() });
    }
    const body = parsed.data;

    if (body.groupId) {
      const memberCheck = await fastify.db.query<{ id: string }>(
        `SELECT id FROM convoy_members WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL`,
        [body.groupId, userId],
      );
      if (memberCheck.rows.length === 0) {
        return reply.status(403).send({ error: 'Not an active member of the specified group' });
      }
    }

    const result = await fastify.db.query<{ id: string; created_at: Date }>(
      `INSERT INTO drive_history
         (user_id, group_id, route_trace, distance_m, duration_s,
          avg_speed_kph, top_speed_kph, member_count, started_at, ended_at, synced_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, now())
       RETURNING id, created_at`,
      [
        userId,
        body.groupId ?? null,
        JSON.stringify(body.routeTrace),
        body.distanceM,
        body.durationS,
        body.avgSpeedKph ?? null,
        body.topSpeedKph ?? null,
        body.memberCount,
        body.startedAt,
        body.endedAt,
      ],
    );
    const row = result.rows[0];

    const drive: DriveResponse = {
      id: row.id,
      userId,
      groupId: body.groupId ?? null,
      routeTrace: body.routeTrace,
      distanceM: body.distanceM,
      durationS: body.durationS,
      avgSpeedKph: body.avgSpeedKph ?? null,
      topSpeedKph: body.topSpeedKph ?? null,
      memberCount: body.memberCount,
      startedAt: body.startedAt,
      endedAt: body.endedAt,
      summaryCardUrl: null,
      createdAt: row.created_at.toISOString(),
    };

    return reply.status(201).send(drive);
  });

  // ── POST /drives/:id/summary-card ─────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/drives/:id/summary-card',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const { id } = request.params;

      const driveResult = await fastify.db.query<{
        id: string;
        route_trace: { type: string; coordinates: [number, number][] };
      }>(
        'SELECT id, route_trace FROM drive_history WHERE id = $1 AND user_id = $2',
        [id, userId],
      );
      if (driveResult.rows.length === 0) {
        return reply.status(404).send({ error: 'Drive not found' });
      }
      const { route_trace } = driveResult.rows[0];
      const coordinates = (route_trace as { coordinates: [number, number][] }).coordinates ?? [];

      // Store the token-free URL; token is appended at serve time so rotation doesn't break rows
      const storedUrl = buildSummaryCardUrl(coordinates);

      await fastify.db.query(
        'UPDATE drive_history SET summary_card_url = $1 WHERE id = $2',
        [storedUrl, id],
      );

      return reply.send({ summaryCardUrl: hydrateSummaryCardUrl(storedUrl, env.MAPBOX_API_TOKEN) });
    },
  );

  // ── DELETE /drives/:id ────────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>('/drives/:id', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params;

    const result = await fastify.db.query(
      'DELETE FROM drive_history WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, userId],
    );
    if (result.rowCount === 0) return reply.status(404).send({ error: 'Drive not found' });
    return reply.status(200).send({ success: true, id });
  });
};

export default drivesRoutes;

