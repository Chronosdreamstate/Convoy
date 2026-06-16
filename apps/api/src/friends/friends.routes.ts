import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW = 3600; // 1 hour in seconds

const requestBodySchema = z.object({
  addresseeId: z.string().uuid(),
});

const blockBodySchema = z.object({
  userId: z.string().uuid(),
});

interface FriendshipRow {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: 'pending' | 'accepted' | 'blocked';
  created_at: Date;
}

interface UserPublic {
  id: string;
  display_name: string;
  avatar_url: string | null;
  ptt_callsign: string | null;
  privacy: string;
}

async function friendsRoutes(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  // -------------------------------------------------------------------------
  // Helper: check if a block exists in either direction between two users
  // -------------------------------------------------------------------------
  async function isBlocked(userA: string, userB: string): Promise<boolean> {
    const result = await fastify.db.query(
      `SELECT 1 FROM friendships
       WHERE status = 'blocked'
         AND ((requester_id = $1 AND addressee_id = $2)
           OR (requester_id = $2 AND addressee_id = $1))
       LIMIT 1`,
      [userA, userB],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // -------------------------------------------------------------------------
  // GET /friends/invite-link — generate a deep-link invite (Req 17.1, 17.2)
  // -------------------------------------------------------------------------
  fastify.get('/friends/invite-link', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const link = `convoy://invite?userId=${userId}`;
    return reply.send({ inviteLink: link, qrData: link });
  });

  // -------------------------------------------------------------------------
  // POST /friends/request — send a friend request (Req 17.3–17.7)
  // -------------------------------------------------------------------------
  fastify.post('/friends/request', { preHandler: [authenticate] }, async (request, reply) => {
    const requesterId = (request.user as { sub: string }).sub;

    const parsed = requestBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.errors[0].message);
    }
    const { addresseeId } = parsed.data;

    if (requesterId === addresseeId) {
      return reply.badRequest('You cannot send a friend request to yourself');
    }

    // Rate limit: 20 requests per user per hour
    const rlKey = `rl:friends:${requesterId}`;
    const current = await fastify.redis.incr(rlKey);
    if (current === 1) {
      await fastify.redis.expire(rlKey, RATE_LIMIT_WINDOW);
    }
    if (current > RATE_LIMIT_MAX) {
      return reply.tooManyRequests('Too many friend requests. Please try again later.');
    }

    // Block enforcement (Req 17.11)
    if (await isBlocked(requesterId, addresseeId)) {
      return reply.forbidden('Unable to send friend request');
    }

    // Check for existing relationship
    const existing = await fastify.db.query<FriendshipRow>(
      `SELECT id, status FROM friendships
       WHERE (requester_id = $1 AND addressee_id = $2)
          OR (requester_id = $2 AND addressee_id = $1)
       LIMIT 1`,
      [requesterId, addresseeId],
    );
    if (existing.rows[0]) {
      const { status } = existing.rows[0];
      if (status === 'accepted') return reply.conflict('You are already friends');
      if (status === 'pending') return reply.conflict('A friend request already exists');
    }

    // Read the addressee's privacy setting
    const addresseeResult = await fastify.db.query<{ privacy: string }>(
      `SELECT privacy FROM users WHERE id = $1`,
      [addresseeId],
    );
    if (!addresseeResult.rows[0]) {
      return reply.notFound('User not found');
    }

    // Privacy-based auto-accept (Req 17.6, 17.7)
    const initialStatus =
      addresseeResult.rows[0].privacy === 'open' ? 'accepted' : 'pending';

    const result = await fastify.db.query<FriendshipRow>(
      `INSERT INTO friendships (requester_id, addressee_id, status)
       VALUES ($1, $2, $3)
       RETURNING id, requester_id, addressee_id, status, created_at`,
      [requesterId, addresseeId, initialStatus],
    );

    return reply.status(201).send({
      id: result.rows[0].id,
      status: result.rows[0].status,
      autoAccepted: initialStatus === 'accepted',
    });
  });

  // -------------------------------------------------------------------------
  // GET /friends/requests — incoming pending requests (Req 17.7)
  // -------------------------------------------------------------------------
  fastify.get('/friends/requests', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const result = await fastify.db.query<
      FriendshipRow & { display_name: string; avatar_url: string | null }
    >(
      `SELECT f.id, f.requester_id, f.addressee_id, f.status, f.created_at,
              u.display_name, u.avatar_url
       FROM friendships f
       JOIN users u ON u.id = f.requester_id
       WHERE f.addressee_id = $1 AND f.status = 'pending'
       ORDER BY f.created_at DESC`,
      [userId],
    );

    return reply.send({
      requests: result.rows.map((r) => ({
        id: r.id,
        requesterId: r.requester_id,
        displayName: r.display_name,
        avatarUrl: r.avatar_url,
        createdAt: r.created_at,
      })),
    });
  });

  // -------------------------------------------------------------------------
  // POST /friends/requests/:id/accept (Req 17.8)
  // -------------------------------------------------------------------------
  fastify.post(
    '/friends/requests/:id/accept',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const { id } = request.params as { id: string };

      const result = await fastify.db.query<FriendshipRow>(
        `UPDATE friendships
         SET status = 'accepted'
         WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
         RETURNING id, requester_id, addressee_id, status`,
        [id, userId],
      );

      if (!result.rows[0]) {
        return reply.notFound('Friend request not found');
      }

      return reply.send({ id: result.rows[0].id, status: 'accepted' });
    },
  );

  // -------------------------------------------------------------------------
  // POST /friends/requests/:id/decline — delete silently (Req 17.9)
  // -------------------------------------------------------------------------
  fastify.post(
    '/friends/requests/:id/decline',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const { id } = request.params as { id: string };

      const result = await fastify.db.query(
        `DELETE FROM friendships
         WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
         RETURNING id`,
        [id, userId],
      );

      if (result.rowCount === 0) {
        return reply.notFound('Friend request not found');
      }

      return reply.status(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // GET /friends — list accepted friends (both directions) (Req 17.1)
  // -------------------------------------------------------------------------
  fastify.get('/friends', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const result = await fastify.db.query<
      { friendship_id: string; created_at: Date } & UserPublic
    >(
      `SELECT f.id AS friendship_id, f.created_at,
              u.id, u.display_name, u.avatar_url, u.ptt_callsign, u.privacy
       FROM friendships f
       JOIN users u ON u.id = CASE
         WHEN f.requester_id = $1 THEN f.addressee_id
         ELSE f.requester_id
       END
       WHERE f.status = 'accepted'
         AND (f.requester_id = $1 OR f.addressee_id = $1)
       ORDER BY u.display_name ASC`,
      [userId],
    );

    return reply.send({
      friends: result.rows.map((r) => ({
        friendshipId: r.friendship_id,
        userId: r.id,
        displayName: r.display_name,
        avatarUrl: r.avatar_url,
        pttCallsign: r.ptt_callsign,
        privacy: r.privacy,
        friendsSince: r.created_at,
      })),
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /friends/:id — remove a friend by friendship ID (Req 17.10)
  // Bidirectional: deleting the row removes it from both users' lists.
  // -------------------------------------------------------------------------
  fastify.delete('/friends/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };

    const result = await fastify.db.query(
      `DELETE FROM friendships
       WHERE id = $1
         AND status = 'accepted'
         AND (requester_id = $2 OR addressee_id = $2)
       RETURNING id`,
      [id, userId],
    );

    if (result.rowCount === 0) {
      return reply.notFound('Friendship not found');
    }

    return reply.status(204).send();
  });

  // -------------------------------------------------------------------------
  // POST /friends/block — block a user (Req 17.11)
  // Removes any existing friendship/request then writes blocked row.
  // -------------------------------------------------------------------------
  fastify.post('/friends/block', { preHandler: [authenticate] }, async (request, reply) => {
    const blockerId = (request.user as { sub: string }).sub;

    const parsed = blockBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.errors[0].message);
    }
    const { userId: blockedId } = parsed.data;

    if (blockerId === blockedId) {
      return reply.badRequest('You cannot block yourself');
    }

    const client = await fastify.db.connect();
    try {
      await client.query('BEGIN');

      // Remove any existing friendship or pending request in either direction
      await client.query(
        `DELETE FROM friendships
         WHERE (requester_id = $1 AND addressee_id = $2)
            OR (requester_id = $2 AND addressee_id = $1)`,
        [blockerId, blockedId],
      );

      // Insert block record (blocker → blocked)
      await client.query(
        `INSERT INTO friendships (requester_id, addressee_id, status)
         VALUES ($1, $2, 'blocked')
         ON CONFLICT (requester_id, addressee_id)
         DO UPDATE SET status = 'blocked'`,
        [blockerId, blockedId],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return reply.status(200).send({ message: 'User blocked' });
  });
}

export default friendsRoutes;
