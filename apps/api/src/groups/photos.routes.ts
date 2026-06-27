import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';

const createPhotoSchema = z.object({
  photoUrl: z.string().url().min(1),
  caption: z.string().max(280).optional(),
  driveId: z.string().uuid().optional(),
});

export default async function photosRoutes(fastify: FastifyInstance) {
  // GET /groups/:groupId/photos
  fastify.get<{ Params: { groupId: string } }>(
    '/groups/:groupId/photos',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (req, reply) => {
      const userId = (req.user as { sub: string }).sub;
      const { groupId } = req.params;

      // Membership check
      const memberCheck = await fastify.db.query(
        `SELECT 1 FROM convoy_members WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL`,
        [groupId, userId],
      );
      if ((memberCheck.rowCount ?? 0) === 0) return reply.forbidden('Not a member of this group');

      const result = await fastify.db.query<{
        id: string;
        user_id: string;
        display_name: string;
        photo_url: string;
        caption: string | null;
        created_at: string;
      }>(
        `SELECT gp.id, gp.user_id, u.display_name, gp.photo_url, gp.caption, gp.created_at
         FROM group_photos gp
         JOIN users u ON u.id = gp.user_id
         WHERE gp.group_id = $1
         ORDER BY gp.created_at DESC
         LIMIT 50`,
        [groupId],
      );
      return reply.send({
        photos: result.rows.map((r) => ({
          id: r.id,
          userId: r.user_id,
          displayName: r.display_name,
          photoUrl: r.photo_url,
          caption: r.caption,
          createdAt: r.created_at,
        })),
      });
    },
  );

  // POST /groups/:groupId/photos
  fastify.post<{ Params: { groupId: string } }>(
    '/groups/:groupId/photos',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (req, reply) => {
      const userId = (req.user as { sub: string }).sub;
      const { groupId } = req.params;

      const parsed = createPhotoSchema.safeParse(req.body);
      if (!parsed.success) return reply.badRequest(parsed.error.errors[0].message);
      const { photoUrl, caption, driveId } = parsed.data;

      // Membership check
      const memberCheck = await fastify.db.query(
        `SELECT 1 FROM convoy_members WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL`,
        [groupId, userId],
      );
      if ((memberCheck.rowCount ?? 0) === 0) return reply.forbidden('Not a member of this group');

      const result = await fastify.db.query<{
        id: string; photo_url: string; caption: string | null; created_at: string;
      }>(
        `INSERT INTO group_photos (group_id, user_id, photo_url, caption, drive_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, photo_url, caption, created_at`,
        [groupId, userId, photoUrl, caption ?? null, driveId ?? null],
      );

      // Broadcast to group so photo library updates in real-time
      fastify.io.to(`group:${groupId}`).emit('group:photo_added', {
        id: result.rows[0].id,
        userId,
        photoUrl,
        caption: caption ?? null,
        createdAt: result.rows[0].created_at,
      });

      return reply.status(201).send({ photo: result.rows[0] });
    },
  );

  // DELETE /groups/:groupId/photos/:photoId
  fastify.delete<{ Params: { groupId: string; photoId: string } }>(
    '/groups/:groupId/photos/:photoId',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (req, reply) => {
      const userId = (req.user as { sub: string }).sub;
      const { groupId, photoId } = req.params;

      const result = await fastify.db.query(
        `DELETE FROM group_photos
         WHERE id = $1 AND group_id = $2 AND user_id = $3
         RETURNING id`,
        [photoId, groupId, userId],
      );
      if ((result.rowCount ?? 0) === 0) return reply.notFound('Photo not found or not yours');
      return reply.status(204).send();
    },
  );
}
