import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';
import { isBlocked } from '../friends/friends.routes';

// ---------------------------------------------------------------------------
// Privacy constants
// ---------------------------------------------------------------------------
// Coordinates are snapped to a coarse grid before they are ever stored or
// returned. 3 decimal places ≈ 110 m, so a stranger can never derive a user's
// exact position from the nearby API — only which ~110 m cell they are in.
const SNAP_DECIMALS = 3;
// Distances are further bucketed to the nearest 100 m in the response.
const DISTANCE_BUCKET_M = 100;
// Only surface users whose approximate presence was refreshed recently.
const PRESENCE_FRESHNESS = '30 minutes';

const DEFAULT_RADIUS_M = 5000;
const MAX_RADIUS_M = 50000;

function snapCoord(value: number): number {
  const factor = 10 ** SNAP_DECIMALS;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const nearbyQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusM: z.coerce.number().int().min(100).max(MAX_RADIUS_M).optional().default(DEFAULT_RADIUS_M),
});

const startDmSchema = z.object({
  userId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------
interface NearbyRow {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  approx_lat: number;
  approx_lng: number;
  distance_m: number;
}

async function nearbyRoutes(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /nearby?lat=&lng=&radiusM=
  // Find opted-in users within radius of the requester. Requires the requester
  // to also be opted-in (visible_to_nearby) — discovery is mutual/symmetric.
  // Returns approximate location + bucketed distance ONLY. No exact coords.
  // -------------------------------------------------------------------------
  fastify.get(
    '/nearby',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;

      const parsed = nearbyQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.badRequest(parsed.error.errors[0].message);
      const { lat, lng, radiusM } = parsed.data;

      // Ensure a settings row exists and confirm the requester opted in.
      await fastify.db.query(
        `INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [userId],
      );
      const settings = await fastify.db.query<{ visible_to_nearby: boolean }>(
        `SELECT visible_to_nearby FROM user_settings WHERE user_id = $1`,
        [userId],
      );
      if (!settings.rows[0]?.visible_to_nearby) {
        return reply.forbidden('Enable "Visible to nearby" to use nearby discovery');
      }

      // Snap the requester's coordinates server-side. Only the coarse point is
      // ever persisted or used for distance math — exact coords never leave here.
      const snappedLat = snapCoord(lat);
      const snappedLng = snapCoord(lng);

      // Refresh the requester's own approximate presence so they remain
      // discoverable to others while actively browsing.
      await fastify.db.query(
        `INSERT INTO nearby_presence (user_id, approx_location, updated_at)
         VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, now())
         ON CONFLICT (user_id)
         DO UPDATE SET approx_location = EXCLUDED.approx_location, updated_at = now()`,
        [userId, snappedLng, snappedLat],
      );

      // Find other opted-in, recently-active users within the radius.
      // Req 17.11: a block in either direction must hide both the blocker's
      // and the blocked user's location from each other, so nearby-strangers
      // discovery (which is exactly a location-viewing feature) is not a
      // backdoor around a block. Enforced here as a SQL-level NOT EXISTS
      // anti-join (mirroring the same pattern used by /friends/search) rather
      // than an application-level filter, so a blocked pair never shows up in
      // the result set or its ORDER BY / LIMIT 100 windowing at all — this
      // avoids any response-shape or timing side channel that a post-hoc
      // filter could leak.
      const result = await fastify.db.query<NearbyRow>(
        `SELECT np.user_id,
                u.display_name,
                u.avatar_url,
                ST_Y(np.approx_location::geometry) AS approx_lat,
                ST_X(np.approx_location::geometry) AS approx_lng,
                ST_Distance(np.approx_location, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography) AS distance_m
         FROM nearby_presence np
         JOIN users u ON u.id = np.user_id
         JOIN user_settings s ON s.user_id = np.user_id AND s.visible_to_nearby = true
         WHERE np.user_id <> $1
           AND np.updated_at > now() - INTERVAL '${PRESENCE_FRESHNESS}'
           AND ST_DWithin(np.approx_location, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)
           AND NOT EXISTS (
             SELECT 1 FROM friendships b
             WHERE b.status = 'blocked'
               AND ((b.requester_id = $1 AND b.addressee_id = np.user_id)
                 OR (b.requester_id = np.user_id AND b.addressee_id = $1))
           )
         ORDER BY distance_m ASC
         LIMIT 100`,
        [userId, snappedLng, snappedLat, radiusM],
      );

      const users = result.rows.map((row) => ({
        userId: row.user_id,
        displayName: row.display_name,
        avatarUrl: row.avatar_url ?? null,
        approxLat: snapCoord(row.approx_lat),
        approxLng: snapCoord(row.approx_lng),
        // Bucket distance to the nearest 100 m to avoid leaking precise range.
        distanceM: Math.round(row.distance_m / DISTANCE_BUCKET_M) * DISTANCE_BUCKET_M,
      }));

      return reply.send({ users, radiusM });
    },
  );

  // -------------------------------------------------------------------------
  // POST /nearby/dm — start (or reuse) a one-off DM with a nearby stranger.
  // Reuses convoy_groups.type='dm' + the normal group-chat infrastructure.
  // Both parties must be opted-in to nearby (no friendship required).
  // -------------------------------------------------------------------------
  fastify.post(
    '/nearby/dm',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;

      const parsed = startDmSchema.safeParse(request.body);
      if (!parsed.success) return reply.badRequest(parsed.error.errors[0].message);
      const { userId: strangerId } = parsed.data;

      if (strangerId === userId) return reply.badRequest('Cannot DM yourself');

      // Both users must currently be opted-in to nearby discovery.
      await fastify.db.query(
        `INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [userId],
      );
      const optIn = await fastify.db.query<{ user_id: string }>(
        `SELECT user_id FROM user_settings
         WHERE user_id IN ($1, $2) AND visible_to_nearby = true`,
        [userId, strangerId],
      );
      const optedInIds = new Set(optIn.rows.map((r) => r.user_id));
      if (!optedInIds.has(userId)) {
        return reply.forbidden('Enable "Visible to nearby" to message nearby people');
      }
      if (!optedInIds.has(strangerId)) {
        return reply.forbidden('This user is not available for nearby messages');
      }

      // Block enforcement (Req 17.11) — checked BEFORE any DM group lookup/
      // creation so a blocked pair can neither reuse nor open a new DM.
      // Reuses the same isBlocked() helper as friends.routes.ts rather than
      // reimplementing block detection here.
      if (await isBlocked(fastify.db, userId, strangerId)) {
        return reply.forbidden('This user is not available for nearby messages');
      }

      // Find an existing DM group shared by exactly these two users.
      const existing = await fastify.db.query<{ id: string }>(
        `SELECT g.id FROM convoy_groups g
         JOIN convoy_members m1 ON m1.group_id = g.id AND m1.user_id = $1 AND m1.left_at IS NULL
         JOIN convoy_members m2 ON m2.group_id = g.id AND m2.user_id = $2 AND m2.left_at IS NULL
         WHERE g.type = 'dm'
           AND (SELECT COUNT(*) FROM convoy_members WHERE group_id = g.id AND left_at IS NULL) = 2
         LIMIT 1`,
        [userId, strangerId],
      );

      if ((existing.rowCount ?? 0) > 0) {
        return reply.send({ groupId: existing.rows[0].id });
      }

      // Create a new DM group — retry on join_code collision.
      let groupId: string | null = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const joinCode = randomBytes(3).toString('hex').toUpperCase();
        try {
          const created = await fastify.db.query<{ id: string }>(
            `INSERT INTO convoy_groups (name, join_code, admin_id, access_type, type)
             VALUES ('dm', $1, $2, 'invite_only', 'dm')
             RETURNING id`,
            [joinCode, userId],
          );
          groupId = created.rows[0].id;
          break;
        } catch (err: unknown) {
          if ((err as { code?: string }).code !== '23505') throw err;
        }
      }

      if (!groupId) return reply.internalServerError('Could not create DM channel');

      await fastify.db.query(
        `INSERT INTO convoy_members (group_id, user_id) VALUES ($1, $2), ($1, $3)`,
        [groupId, userId, strangerId],
      );

      return reply.status(201).send({ groupId });
    },
  );
}

export default nearbyRoutes;
