import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';

const patchSettingsSchema = z.object({
  hazardAlertDistanceM: z.number().int().min(100).max(80000).optional(),
  pttMaxSeconds: z.number().int().min(5).max(60).optional(),
  tileCacheLimitMb: z.number().int().min(100).max(500).optional(),
  scenicRouting: z.boolean().optional(),
  mapStyle: z.enum(['standard', 'satellite', 'hybrid']).optional(),
  notifHazard: z.boolean().optional(),
  notifGroupEvents: z.boolean().optional(),
  notifFriendRequests: z.boolean().optional(),
  notifNavigation: z.boolean().optional(),
});

interface SettingsRow {
  user_id: string;
  hazard_alert_distance_m: number;
  ptt_max_seconds: number;
  tile_cache_limit_mb: number;
  scenic_routing: boolean;
  map_style: string;
  notif_hazard: boolean;
  notif_group_events: boolean;
  notif_friend_requests: boolean;
  notif_navigation: boolean;
}

function toResponse(s: SettingsRow) {
  return {
    hazardAlertDistanceM: s.hazard_alert_distance_m,
    pttMaxSeconds: s.ptt_max_seconds,
    tileCacheLimitMb: s.tile_cache_limit_mb,
    scenicRouting: s.scenic_routing,
    mapStyle: s.map_style,
    notifHazard: s.notif_hazard,
    notifGroupEvents: s.notif_group_events,
    notifFriendRequests: s.notif_friend_requests,
    notifNavigation: s.notif_navigation,
  };
}

async function settingsRoutes(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /settings
  // -------------------------------------------------------------------------
  fastify.get('/settings', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    // Ensure a settings row exists (idempotent seed)
    await fastify.db.query(
      `INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [userId],
    );

    const result = await fastify.db.query<SettingsRow>(
      `SELECT * FROM user_settings WHERE user_id = $1`,
      [userId],
    );

    return reply.send(toResponse(result.rows[0]));
  });

  // -------------------------------------------------------------------------
  // PATCH /settings
  // -------------------------------------------------------------------------
  fastify.patch('/settings', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const parsed = patchSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.errors[0].message);
    }

    const data = parsed.data;

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (data.hazardAlertDistanceM !== undefined) {
      setClauses.push(`hazard_alert_distance_m = $${paramIdx++}`);
      values.push(data.hazardAlertDistanceM);
    }
    if (data.pttMaxSeconds !== undefined) {
      setClauses.push(`ptt_max_seconds = $${paramIdx++}`);
      values.push(data.pttMaxSeconds);
    }
    if (data.tileCacheLimitMb !== undefined) {
      setClauses.push(`tile_cache_limit_mb = $${paramIdx++}`);
      values.push(data.tileCacheLimitMb);
    }
    if (data.scenicRouting !== undefined) {
      setClauses.push(`scenic_routing = $${paramIdx++}`);
      values.push(data.scenicRouting);
    }
    if (data.mapStyle !== undefined) {
      setClauses.push(`map_style = $${paramIdx++}`);
      values.push(data.mapStyle);
    }
    if (data.notifHazard !== undefined) {
      setClauses.push(`notif_hazard = $${paramIdx++}`);
      values.push(data.notifHazard);
    }
    if (data.notifGroupEvents !== undefined) {
      setClauses.push(`notif_group_events = $${paramIdx++}`);
      values.push(data.notifGroupEvents);
    }
    if (data.notifFriendRequests !== undefined) {
      setClauses.push(`notif_friend_requests = $${paramIdx++}`);
      values.push(data.notifFriendRequests);
    }
    if (data.notifNavigation !== undefined) {
      setClauses.push(`notif_navigation = $${paramIdx++}`);
      values.push(data.notifNavigation);
    }

    // Ensure the row exists before updating
    await fastify.db.query(
      `INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [userId],
    );

    if (setClauses.length === 0) {
      const result = await fastify.db.query<SettingsRow>(
        `SELECT * FROM user_settings WHERE user_id = $1`,
        [userId],
      );
      return reply.send(toResponse(result.rows[0]));
    }

    values.push(userId);

    const result = await fastify.db.query<SettingsRow>(
      `UPDATE user_settings SET ${setClauses.join(', ')}
       WHERE user_id = $${paramIdx}
       RETURNING *`,
      values,
    );

    return reply.send(toResponse(result.rows[0]));
  });
}

export default settingsRoutes;

