import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';

const openDmSchema = z.object({
  friendId: z.string().uuid(),
});

export default async function dmRoutes(fastify: FastifyInstance) {
  // POST /api/v1/dm — find or create a DM conversation with a friend
  fastify.post('/dm', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;

    const parsed = openDmSchema.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.errors[0].message);
    const { friendId } = parsed.data;

    if (friendId === userId) return reply.badRequest('Cannot DM yourself');

    // Verify accepted friendship
    const friendCheck = await fastify.db.query(
      `SELECT 1 FROM friendships
       WHERE status = 'accepted'
         AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))`,
      [userId, friendId],
    );
    if ((friendCheck.rowCount ?? 0) === 0) return reply.forbidden('You are not friends with this user');

    // Find existing DM channel shared by exactly these two users
    const existing = await fastify.db.query<{ id: string }>(
      `SELECT g.id FROM convoy_groups g
       JOIN convoy_members m1 ON m1.group_id = g.id AND m1.user_id = $1 AND m1.left_at IS NULL
       JOIN convoy_members m2 ON m2.group_id = g.id AND m2.user_id = $2 AND m2.left_at IS NULL
       WHERE g.type = 'dm'
         AND (SELECT COUNT(*) FROM convoy_members WHERE group_id = g.id AND left_at IS NULL) = 2
       LIMIT 1`,
      [userId, friendId],
    );

    if ((existing.rowCount ?? 0) > 0) {
      return reply.send({ groupId: existing.rows[0].id });
    }

    // Create new DM channel — retry up to 5 times on join_code collision
    let groupId: string | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const joinCode = randomBytes(3).toString('hex').toUpperCase();
      try {
        const result = await fastify.db.query<{ id: string }>(
          `INSERT INTO convoy_groups (name, join_code, admin_id, access_type, type)
           VALUES ('dm', $1, $2, 'invite_only', 'dm')
           RETURNING id`,
          [joinCode, userId],
        );
        groupId = result.rows[0].id;
        break;
      } catch (err: unknown) {
        if ((err as { code?: string }).code !== '23505') throw err; // only retry on unique violation
      }
    }

    if (!groupId) return reply.internalServerError('Could not create DM channel');

    await fastify.db.query(
      `INSERT INTO convoy_members (group_id, user_id) VALUES ($1, $2), ($1, $3)`,
      [groupId, userId, friendId],
    );

    return reply.status(201).send({ groupId });
  });
}
