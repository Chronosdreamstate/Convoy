import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';

const CAMERA_TYPES = ['fixed', 'mobile', 'avg_speed', 'red_light'] as const;

const createCameraSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  type: z.enum(CAMERA_TYPES).default('fixed'),
  speedLimitKph: z.number().int().min(0).max(300).optional(),
  direction: z.number().min(0).max(360).optional(),
  source: z.enum(['community', 'opendata']).default('community'),
});

const voteSchema = z.object({
  vote: z.enum(['confirm', 'deny']),
});

// Haversine filter — avoids PostGIS dependency
function haversineMeters(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const h = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export default async function speedCamerasRoutes(fastify: FastifyInstance): Promise<void> {
  const pool: Pool = fastify.db;

  // GET /speed-cameras?lat=&lng=&radius= (km)
  fastify.get(
    '/speed-cameras',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const { lat, lng, radius } = request.query as {
        lat?: string; lng?: string; radius?: string;
      };

      if (!lat || !lng) return reply.badRequest('lat and lng are required');

      const latNum = parseFloat(lat);
      const lngNum = parseFloat(lng);
      const radiusKm = radius ? Math.min(parseFloat(radius), 50) : 10;

      if (isNaN(latNum) || isNaN(lngNum) || isNaN(radiusKm)) {
        return reply.badRequest('lat, lng, and radius must be valid numbers');
      }

      // Use a bounding box pre-filter to avoid full table scan, then exact haversine in JS
      const degLat = radiusKm / 111.0;
      const degLng = radiusKm / (111.0 * Math.cos((latNum * Math.PI) / 180));

      const rows = await pool.query<{
        id: string; lat: number; lng: number; type: string;
        speed_limit_kph: number | null; direction: number | null;
        source: string; confirmed_at: Date | null;
        upvotes: number; downvotes: number;
      }>(
        `SELECT id, lat, lng, type, speed_limit_kph, direction, source,
                confirmed_at, upvotes, downvotes
         FROM speed_cameras
         WHERE is_active = TRUE
           AND lat BETWEEN $1 AND $2
           AND lng BETWEEN $3 AND $4`,
        [latNum - degLat, latNum + degLat, lngNum - degLng, lngNum + degLng],
      );

      const radiusM = radiusKm * 1000;
      const cameras = rows.rows
        .filter((r) => haversineMeters(latNum, lngNum, r.lat, r.lng) <= radiusM)
        .map((r) => ({
          id: r.id,
          lat: r.lat,
          lng: r.lng,
          type: r.type,
          speedLimitKph: r.speed_limit_kph,
          direction: r.direction,
          source: r.source,
          confirmedAt: r.confirmed_at?.getTime() ?? null,
          upvotes: r.upvotes,
          downvotes: r.downvotes,
        }));

      return { cameras };
    },
  );

  // POST /speed-cameras — report a new speed camera
  fastify.post(
    '/speed-cameras',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const parsed = createCameraSchema.safeParse(request.body);
      if (!parsed.success) return reply.badRequest(parsed.error.errors[0].message);

      const { lat, lng, type, speedLimitKph, direction, source } = parsed.data;

      const result = await pool.query<{ id: string; created_at: Date }>(
        `INSERT INTO speed_cameras (lat, lng, type, speed_limit_kph, direction, source, reporter_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, created_at`,
        [lat, lng, type, speedLimitKph ?? null, direction ?? null, source, userId],
      );

      return reply.code(201).send({
        id: result.rows[0].id,
        lat, lng, type, source,
        createdAt: result.rows[0].created_at.toISOString(),
      });
    },
  );

  // POST /speed-cameras/:id/vote — confirm or deny a camera exists
  fastify.post(
    '/speed-cameras/:id/vote',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = voteSchema.safeParse(request.body);
      if (!parsed.success) return reply.badRequest(parsed.error.errors[0].message);

      const { vote } = parsed.data;
      const col = vote === 'confirm' ? 'upvotes' : 'downvotes';

      const result = await pool.query<{
        id: string; upvotes: number; downvotes: number; is_active: boolean;
      }>(
        // Auto-deactivate if downvotes >= 5
        `UPDATE speed_cameras
         SET ${col} = ${col} + 1,
             is_active = CASE WHEN downvotes + 1 >= 5 AND $2 = 'deny' THEN FALSE ELSE is_active END,
             confirmed_at = CASE WHEN $2 = 'confirm' THEN now() ELSE confirmed_at END
         WHERE id = $1 AND is_active = TRUE
         RETURNING id, upvotes, downvotes, is_active`,
        [id, vote],
      );

      if ((result.rowCount ?? 0) === 0) return reply.notFound('Speed camera not found');

      return result.rows[0];
    },
  );
}
