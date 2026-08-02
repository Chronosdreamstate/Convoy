import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';
import { haversineMeters } from '../utils/geo';

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
        .filter((r) => haversineMeters({ lat: latNum, lng: lngNum }, { lat: r.lat, lng: r.lng }) <= radiusM)
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

      // Camera reports are queued offline and replayed on reconnect, so a
      // report whose 201 was lost after the INSERT committed arrives a second
      // time and used to become a second pin on everyone's map — with the
      // deactivation votes then split across the copies. Same reporter, same
      // type, within ~11 m of a camera that is still active is a replay, not a
      // new camera. (Matches the drive and hazard-bulk guards; the client's
      // own dedupeKey only collapses duplicates still sitting in the queue.)
      const result = await pool.query<{ id: string; created_at: Date }>(
        `INSERT INTO speed_cameras (lat, lng, type, speed_limit_kph, direction, source, reporter_id)
         -- Casts are required: $1..$3 appear both as inserted values and in
         -- the guard's comparisons, which Postgres otherwise deduces
         -- inconsistent types for.
         SELECT $1::double precision, $2::double precision, $3::varchar,
                $4::integer, $5::integer, $6::varchar, $7::uuid
         WHERE NOT EXISTS (
           SELECT 1 FROM speed_cameras
            WHERE reporter_id = $7::uuid AND type = $3::varchar AND is_active = TRUE
              AND abs(lat - $1::double precision) < 0.0001
              AND abs(lng - $2::double precision) < 0.0001
         )
         RETURNING id, created_at`,
        [lat, lng, type, speedLimitKph ?? null, direction ?? null, source, userId],
      );

      if (result.rows.length === 0) {
        const existing = await pool.query<{ id: string; created_at: Date }>(
          `SELECT id, created_at FROM speed_cameras
            WHERE reporter_id = $3 AND type = $4 AND is_active = TRUE
              AND abs(lat - $1) < 0.0001 AND abs(lng - $2) < 0.0001
            ORDER BY created_at ASC LIMIT 1`,
          [lat, lng, userId, type],
        );
        const row = existing.rows[0];
        if (row) {
          // 200, not 201 — this report is already on the map.
          return reply.code(200).send({
            id: row.id,
            lat, lng, type, source,
            createdAt: row.created_at.toISOString(),
          });
        }
        // Deactivated between the two statements — report it as new after all.
        const retry = await pool.query<{ id: string; created_at: Date }>(
          `INSERT INTO speed_cameras (lat, lng, type, speed_limit_kph, direction, source, reporter_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, created_at`,
          [lat, lng, type, speedLimitKph ?? null, direction ?? null, source, userId],
        );
        return reply.code(201).send({
          id: retry.rows[0].id,
          lat, lng, type, source,
          createdAt: retry.rows[0].created_at.toISOString(),
        });
      }

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

      const userId = (request.user as { sub: string }).sub;
      const { vote } = parsed.data;
      const col = vote === 'confirm' ? 'upvotes' : 'downvotes';

      // One vote per user, as hazard_votes has always enforced. Without this,
      // five denies from a SINGLE user deactivated a camera for everyone, and
      // a vote replayed from the offline queue counted again. Recording the
      // vote first means the counter can only move when the row is new.
      //
      // The 409 is also what the offline queue needs to hear: it treats a
      // conflict as "already applied" and drops the item, instead of retrying
      // a vote that landed.
      try {
        await pool.query(
          `INSERT INTO speed_camera_votes (camera_id, user_id, vote) VALUES ($1, $2, $3)`,
          [id, userId, vote],
        );
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === '23505') return reply.conflict('Already voted on this camera');
        // FK violation — the camera id doesn't exist; report it as such rather
        // than as a 500.
        if (code === '23503') return reply.notFound('Speed camera not found');
        throw err;
      }

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

      if ((result.rowCount ?? 0) === 0) {
        // The camera exists (the FK held) but is already deactivated, so no
        // counter moved. Drop the vote row again — keeping it would bar this
        // user from voting if the camera is ever reported afresh.
        await pool.query(
          `DELETE FROM speed_camera_votes WHERE camera_id = $1 AND user_id = $2`,
          [id, userId],
        );
        return reply.notFound('Speed camera not found');
      }

      return result.rows[0];
    },
  );
}
