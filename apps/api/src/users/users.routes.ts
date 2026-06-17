import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';

const patchMeSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  avatarUrl: z.string().url().nullable().optional(),
  pttCallsign: z.string().max(50).nullable().optional(),
  privacy: z.enum(['open', 'invite_only']).optional(),
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
}

async function usersRoutes(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /users/me
  // -------------------------------------------------------------------------
  fastify.get('/users/me', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const result = await fastify.db.query<UserRow>(
      `SELECT id, display_name, phone_number, email, avatar_url, ptt_callsign, privacy, created_at
       FROM users WHERE id = $1`,
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
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /users/me
  // -------------------------------------------------------------------------
  fastify.patch('/users/me', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const parsed = patchMeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.errors[0].message);
    }

    const { displayName, avatarUrl, pttCallsign, privacy } = parsed.data;

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

    if (values.length === 0) {
      // Nothing to update — return current profile unchanged
      const current = await fastify.db.query<UserRow>(
        `SELECT id, display_name, phone_number, email, avatar_url, ptt_callsign, privacy
         FROM users WHERE id = $1`,
        [userId],
      );
      const u = current.rows[0];
      return reply.send({
        id: u.id,
        displayName: u.display_name,
        phoneNumber: u.phone_number,
        email: u.email,
        avatarUrl: u.avatar_url,
        pttCallsign: u.ptt_callsign,
        privacy: u.privacy,
      });
    }

    values.push(userId);

    const result = await fastify.db.query<UserRow>(
      `UPDATE users SET ${setClauses.join(', ')}
       WHERE id = $${paramIdx}
       RETURNING id, display_name, phone_number, email, avatar_url, ptt_callsign, privacy`,
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
    });
  });

  // -------------------------------------------------------------------------
  // GET /users/:id — public profile (used by invite deep-link handler)
  // Returns only non-sensitive public fields regardless of privacy setting,
  // because the viewer already has the UUID (they received an invite link).
  // -------------------------------------------------------------------------
  fastify.get('/users/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const result = await fastify.db.query<
      Pick<UserRow, 'id' | 'display_name' | 'avatar_url' | 'ptt_callsign'>
    >(
      `SELECT id, display_name, avatar_url, ptt_callsign
       FROM users WHERE id = $1`,
      [id],
    );

    const u = result.rows[0];
    if (!u) {
      return reply.notFound('User not found');
    }

    return reply.send({
      id: u.id,
      displayName: u.display_name,
      avatarUrl: u.avatar_url,
      pttCallsign: u.ptt_callsign,
    });
  });

  // -------------------------------------------------------------------------
  // GET /users/search?phone=
  // -------------------------------------------------------------------------
  fastify.get('/users/search', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const phone = (request.query as Record<string, string | undefined>).phone;
    if (!phone) {
      return reply.badRequest('phone query parameter is required');
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
  fastify.post('/devices', { preHandler: [authenticate] }, async (request, reply) => {
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
}

export default usersRoutes;
