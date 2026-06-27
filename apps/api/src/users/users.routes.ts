import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';

const PROFANITY = ['fuck', 'shit', 'ass'];
const profanityFree = (s: string) => !PROFANITY.some((w) => s.toLowerCase().includes(w));

const patchMeSchema = z.object({
  displayName: z.string().min(1).max(50).refine(profanityFree, { message: 'Display name contains disallowed words' }).optional(),
  avatarUrl: z.string().url().nullable().optional(),
  pttCallsign: z.string().max(20).regex(/^[a-zA-Z0-9_-]+$/, 'Callsign must be alphanumeric, dash, or underscore').nullable().optional(),
  privacy: z.enum(['open', 'invite_only']).optional(),
  mods: z.array(z.string().max(100)).max(20).optional(),
});

const deviceSchema = z.object({
  pushToken: z.string().min(1),
  platform: z.enum(['ios', 'android']),
});

interface UserRow {
  id: string;
  display_name: string;
  phone_number: string | null;
  email: string | null;
  avatar_url: string | null;
  ptt_callsign: string | null;
  privacy: string;
  created_at: Date;
  primary_vehicle_type: string | null;
  mods: string[];
}

async function usersRoutes(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /users/me
  // -------------------------------------------------------------------------
  fastify.get('/users/me', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const result = await fastify.db.query<UserRow>(
      `SELECT u.id, u.display_name, u.phone_number, u.email, u.avatar_url, u.ptt_callsign, u.privacy, u.created_at, u.mods,
              (SELECT vehicle_type FROM vehicles WHERE user_id = u.id AND is_active = true LIMIT 1) AS primary_vehicle_type
       FROM users u WHERE u.id = $1`,
      [userId],
    );

    const u = result.rows[0];
    if (!u) {
      return reply.notFound('User not found');
    }

    return reply.send({
      id: u.id,
      displayName: u.display_name,
      phoneNumber: u.phone_number,
      email: u.email,
      avatarUrl: u.avatar_url,
      pttCallsign: u.ptt_callsign,
      privacy: u.privacy,
      createdAt: u.created_at,
      vehicleType: u.primary_vehicle_type ?? undefined,
      mods: u.mods ?? [],
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /users/me
  // -------------------------------------------------------------------------
  fastify.patch('/users/me', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const parsed = patchMeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.errors[0].message);
    }

    const { displayName, avatarUrl, pttCallsign, privacy, mods } = parsed.data;

    // Build partial SET clause — only update fields that were explicitly provided
    const setClauses: string[] = ['updated_at = now()'];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (displayName !== undefined) {
      setClauses.push(`display_name = $${paramIdx++}`);
      values.push(displayName);
    }
    if (avatarUrl !== undefined) {
      setClauses.push(`avatar_url = $${paramIdx++}`);
      values.push(avatarUrl); // null clears the field
    }
    if (pttCallsign !== undefined) {
      setClauses.push(`ptt_callsign = $${paramIdx++}`);
      values.push(pttCallsign);
    }
    if (privacy !== undefined) {
      setClauses.push(`privacy = $${paramIdx++}`);
      values.push(privacy);
    }
    if (mods !== undefined) {
      setClauses.push(`mods = $${paramIdx++}`);
      values.push(mods);
    }

    if (values.length === 0) {
      return reply.badRequest('At least one field must be provided');
    }

    values.push(userId);

    const result = await fastify.db.query<UserRow>(
      `UPDATE users SET ${setClauses.join(', ')}
       WHERE id = $${paramIdx}
       RETURNING id, display_name, phone_number, email, avatar_url, ptt_callsign, privacy, created_at, mods`,
      values,
    );

    const u = result.rows[0];
    return reply.send({
      id: u.id,
      displayName: u.display_name,
      phoneNumber: u.phone_number,
      email: u.email,
      avatarUrl: u.avatar_url,
      pttCallsign: u.ptt_callsign,
      privacy: u.privacy,
      createdAt: u.created_at,
      mods: u.mods ?? [],
    });
  });

  // -------------------------------------------------------------------------
  // GET /users/:id — public profile (used by invite deep-link handler)
  // Returns only non-sensitive public fields regardless of privacy setting,
  // because the viewer already has the UUID (they received an invite link).
  // -------------------------------------------------------------------------
  fastify.get('/users/:id', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const viewerId = (request.user as { sub: string }).sub;

    interface PublicProfileRow {
      id: string;
      display_name: string;
      avatar_url: string | null;
      ptt_callsign: string | null;
      bio: string | null;
      created_at: Date;
      vehicle_type: string | null;
      vehicle_make: string | null;
      vehicle_model: string | null;
      vehicle_year: number | null;
      vehicle_color: string | null;
      mods: string[] | null;
      total_drives: string;
      total_distance_km: string;
    }

    const result = await fastify.db.query<PublicProfileRow>(
      `SELECT u.id, u.display_name, u.avatar_url, u.ptt_callsign, u.bio, u.created_at,
              v.vehicle_type, v.make AS vehicle_make, v.model AS vehicle_model,
              v.year AS vehicle_year, v.color AS vehicle_color, v.mods,
              COALESCE(ds.total_drives, 0)::text AS total_drives,
              COALESCE(ROUND(ds.total_distance_m / 1000.0), 0)::text AS total_distance_km
       FROM users u
       LEFT JOIN LATERAL (
         SELECT vehicle_type, make, model, year, color, mods
         FROM vehicles WHERE user_id = u.id AND is_main = true LIMIT 1
       ) v ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS total_drives, SUM(distance_m) AS total_distance_m
         FROM drives WHERE user_id = u.id
       ) ds ON true
       WHERE u.id = $1`,
      [id],
    );

    const u = result.rows[0];
    if (!u) return reply.notFound('User not found');

    // Check mutual friend count
    const mutualRes = await fastify.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM friends f1
       JOIN friends f2 ON f1.friend_id = f2.user_id AND f2.friend_id = f1.user_id
       WHERE f1.user_id = $1 AND f1.friend_id = $2`,
      [viewerId, id],
    ).catch(() => ({ rows: [{ count: '0' }] }));

    // Check if viewer follows/friends this user
    const friendRes = await fastify.db.query<{ status: string }>(
      `SELECT status FROM friends WHERE user_id = $1 AND friend_id = $2 LIMIT 1`,
      [viewerId, id],
    ).catch(() => ({ rows: [] }));

    return reply.send({
      id: u.id,
      displayName: u.display_name,
      avatarUrl: u.avatar_url,
      callsign: u.ptt_callsign,
      bio: u.bio,
      memberSince: u.created_at,
      vehicleType: u.vehicle_type,
      vehicleMake: u.vehicle_make,
      vehicleModel: u.vehicle_model,
      vehicleYear: u.vehicle_year,
      vehicleColor: u.vehicle_color,
      mods: u.mods ?? [],
      totalDrives: parseInt(u.total_drives, 10),
      totalDistanceKm: parseInt(u.total_distance_km, 10),
      mutualFriends: parseInt(mutualRes.rows[0]?.count ?? '0', 10),
      friendStatus: friendRes.rows[0]?.status ?? null,
    });
  });

  // -------------------------------------------------------------------------
  // GET /users/search?phone=<e164>  — exact phone lookup (single result)
  // GET /users/search?q=<name>      — display-name OR callsign search (array)
  // Pagination: ?page=1&limit=20
  // -------------------------------------------------------------------------
  fastify.get('/users/search', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const query = request.query as Record<string, string | undefined>;
    const phone = query.phone;
    const q = query.q?.trim() ?? '';
    const limitRaw = parseInt(query.limit ?? '20', 10);
    const limit = Number.isNaN(limitRaw) ? 20 : Math.min(50, Math.max(1, limitRaw));
    const pageRaw = parseInt(query.page ?? '1', 10);
    const page = Number.isNaN(pageRaw) || pageRaw < 1 ? 1 : pageRaw;
    const offset = (page - 1) * limit;

    // ── Display-name OR callsign search (FriendsScreen / Find People) ─────
    if (q) {
      if (q.length < 2) return reply.badRequest('q must be at least 2 characters');
      if (q.length > 50) return reply.badRequest('q must be at most 50 characters');

      interface SearchRow extends Pick<UserRow, 'id' | 'display_name' | 'avatar_url' | 'ptt_callsign'> {
        total_count: string;
      }

      const result = await fastify.db.query<SearchRow>(
        `SELECT id, display_name, avatar_url, ptt_callsign,
                COUNT(*) OVER() AS total_count
         FROM users
         WHERE id != $1
           AND privacy = 'open'
           AND (
             display_name ILIKE $2
             OR ptt_callsign ILIKE $2
           )
         ORDER BY
           CASE WHEN LOWER(ptt_callsign) = LOWER($3) THEN 0 ELSE 1 END,
           display_name
         LIMIT $4 OFFSET $5`,
        [userId, `%${q}%`, q, limit, offset],
      );

      const total = result.rows.length > 0 ? parseInt(result.rows[0].total_count, 10) : 0;

      return reply.send({
        users: result.rows.map((u) => ({
          id: u.id,
          displayName: u.display_name,
          avatarUrl: u.avatar_url,
          pttCallsign: u.ptt_callsign,
        })),
        total,
        page,
        limit,
        hasMore: offset + result.rows.length < total,
      });
    }

    // ── Phone lookup (legacy — returns single user object) ─────────────────
    if (!phone) {
      return reply.badRequest('phone or q query parameter is required');
    }

    const result = await fastify.db.query<Pick<UserRow, 'id' | 'display_name' | 'avatar_url' | 'ptt_callsign' | 'privacy'>>(
      `SELECT id, display_name, avatar_url, ptt_callsign, privacy
       FROM users WHERE phone_number = $1 LIMIT 1`,
      [phone],
    );

    const u = result.rows[0];
    if (!u) {
      return reply.send({ user: null });
    }

    if (u.privacy === 'invite_only') {
      const friendCheck = await fastify.db.query(
        `SELECT 1 FROM friendships
         WHERE status = 'accepted'
           AND (
             (requester_id = $1 AND addressee_id = $2)
             OR (requester_id = $2 AND addressee_id = $1)
           )`,
        [userId, u.id],
      );
      if ((friendCheck.rowCount ?? 0) === 0) {
        return reply.send({ user: null });
      }
    }

    return reply.send({
      user: {
        id: u.id,
        displayName: u.display_name,
        avatarUrl: u.avatar_url,
        pttCallsign: u.ptt_callsign,
        privacy: u.privacy,
      },
    });
  });

  // -------------------------------------------------------------------------
  // POST /devices — register / upsert FCM or APNs push token
  // -------------------------------------------------------------------------
  fastify.post('/devices', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const parsed = deviceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.errors[0].message);
    }

    const { pushToken, platform } = parsed.data;

    // Upsert by push_token: reassign user_id if token moved to a different account.
    await fastify.db.query(
      `WITH upd AS (
         UPDATE devices
         SET user_id = $1, platform = $3, updated_at = now()
         WHERE push_token = $2
         RETURNING id
       )
       INSERT INTO devices (user_id, push_token, platform)
       SELECT $1, $2, $3
       WHERE NOT EXISTS (SELECT 1 FROM upd)`,
      [userId, pushToken, platform],
    );

    return reply.status(200).send({ message: 'Device registered' });
  });

  // -------------------------------------------------------------------------
  // GET /users/me/achievements — compute achievement progress from real data
  // -------------------------------------------------------------------------
  fastify.get('/users/me/achievements', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    interface StatsRow {
      convoy_count: string;
      total_distance_m: string;
      night_drives: string;
      max_streak: string;
      groups_created: string;
      photos_shared: string;
    }

    const result = await fastify.db.query<StatsRow>(
      `WITH daily_drives AS (
         SELECT DISTINCT DATE(started_at) AS d
         FROM drive_history
         WHERE user_id = $1 AND group_id IS NOT NULL
       ),
       streak_groups AS (
         SELECT d - (ROW_NUMBER() OVER (ORDER BY d))::INTEGER AS grp
         FROM daily_drives
       ),
       max_streak AS (
         SELECT COALESCE(MAX(cnt), 0) AS val
         FROM (SELECT COUNT(*) AS cnt FROM streak_groups GROUP BY grp) sub
       ),
       drive_stats AS (
         SELECT
           COUNT(*) FILTER (WHERE group_id IS NOT NULL)  AS convoy_count,
           COALESCE(SUM(distance_m), 0)                  AS total_distance_m,
           COUNT(*) FILTER (
             WHERE group_id IS NOT NULL
               AND EXTRACT(HOUR FROM started_at) >= 0
               AND EXTRACT(HOUR FROM started_at) < 4
           ) AS night_drives
         FROM drive_history
         WHERE user_id = $1
       )
       SELECT
         ds.convoy_count,
         ds.total_distance_m,
         ds.night_drives,
         ms.val AS max_streak,
         (SELECT COUNT(*) FROM convoy_groups WHERE admin_id = $1) AS groups_created,
         (SELECT COUNT(*) FROM group_photos  WHERE user_id  = $1) AS photos_shared
       FROM drive_stats ds, max_streak ms`,
      [userId],
    );

    const s = result.rows[0];
    const convoys   = parseInt(s.convoy_count,    10);
    const distKm    = parseInt(s.total_distance_m, 10) / 1000;
    const nightDrives = parseInt(s.night_drives,  10);
    const streak    = parseInt(s.max_streak,       10);
    const groupsCreated = parseInt(s.groups_created, 10);
    const photos    = parseInt(s.photos_shared,    10);

    const achievements = [
      { id: 'first_convoy',   progress: Math.min(convoys, 1),    total: 1,    unlocked: convoys >= 1 },
      { id: 'convoy_10',      progress: Math.min(convoys, 10),   total: 10,   unlocked: convoys >= 10 },
      { id: 'convoy_50',      progress: Math.min(convoys, 50),   total: 50,   unlocked: convoys >= 50 },
      { id: 'distance_100',   progress: Math.min(distKm, 100),   total: 100,  unlocked: distKm >= 100 },
      { id: 'distance_1000',  progress: Math.min(distKm, 1000),  total: 1000, unlocked: distKm >= 1000 },
      { id: 'sos_hero',       progress: 0,                       total: 1,    unlocked: false },
      { id: 'streak_7',       progress: Math.min(streak, 7),     total: 7,    unlocked: streak >= 7 },
      { id: 'group_founder',  progress: Math.min(groupsCreated, 1), total: 1, unlocked: groupsCreated >= 1 },
      { id: 'ptt_master',     progress: 0,                       total: 100,  unlocked: false },
      { id: 'waypoint_setter',progress: 0,                       total: 10,   unlocked: false },
      { id: 'night_owl',      progress: Math.min(nightDrives, 1), total: 1,   unlocked: nightDrives >= 1 },
      { id: 'photo_sharer',   progress: Math.min(photos, 5),     total: 5,    unlocked: photos >= 5 },
    ];

    return reply.send({ achievements });
  });

  // -------------------------------------------------------------------------
  // DELETE /devices/:token — deregister a push token on sign-out
  // -------------------------------------------------------------------------
  fastify.delete('/devices/:token', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { token } = request.params as { token: string };

    // Only delete if the token belongs to the requesting user.
    await fastify.db.query(
      `DELETE FROM devices WHERE push_token = $1 AND user_id = $2`,
      [token, userId],
    );

    return reply.status(204).send();
  });
}

export default usersRoutes;

