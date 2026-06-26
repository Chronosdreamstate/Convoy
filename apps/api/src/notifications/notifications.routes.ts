import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';

interface NotifRow {
  id: string;
  type: string;
  title: string | null;
  body: string | null;
  data: Record<string, unknown>;
  read_at: Date | null;
  created_at: Date;
}

async function notificationsRoutes(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  // GET /notifications — recent notification history (limit 50)
  fastify.get('/notifications', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const result = await fastify.db.query<NotifRow>(
      `SELECT id, type, title, body, data, read_at, created_at
       FROM notification_history
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId],
    );

    return reply.send({
      notifications: result.rows.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        data: n.data,
        readAt: n.read_at,
        createdAt: n.created_at,
      })),
    });
  });

  // PATCH /notifications/:id/read — mark one notification as read
  fastify.patch('/notifications/:id/read', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };

    const result = await fastify.db.query(
      `UPDATE notification_history
       SET read_at = NOW()
       WHERE id = $1 AND user_id = $2 AND read_at IS NULL
       RETURNING id`,
      [id, userId],
    );

    if (result.rowCount === 0) {
      return reply.notFound('Notification not found or already read');
    }

    return reply.send({ ok: true });
  });

  // PATCH /notifications/read-all — mark all notifications as read
  fastify.patch('/notifications/read-all', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    await fastify.db.query(
      `UPDATE notification_history
       SET read_at = NOW()
       WHERE user_id = $1 AND read_at IS NULL`,
      [userId],
    );

    return reply.send({ ok: true });
  });
}

export default notificationsRoutes;
