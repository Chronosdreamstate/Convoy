import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';

const createPhotoSchema = z.object({
  photoUrl: z.string().url().min(1),
  caption: z.string().max(280).optional(),
  driveId: z.string().uuid().optional(),
});

export default async function photosRoutes(fastify: FastifyInstance, opts: { pool: Pool }) {
  const { pool } = opts;

  // GET /api/v1/groups/:groupId/photos
  fastify.get<{ Params: { groupId: string } }>(
    '/api/v1/groups/:groupId/photos',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const { groupId } = req.params;
      const result = await pool.query<{
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

  // POST /api/v1/groups/:groupId/photos
  fastify.post<{ Params: { groupId: string }; Body: z.infer<typeof createPhotoSchema> }>(
    '/api/v1/groups/:groupId/photos',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const parsed = createPhotoSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const { photoUrl, caption, driveId } = parsed.data;
      const userId = (req as unknown as { user: { id: string } }).user.id;
      const { groupId } = req.params;

      const result = await pool.query<{ id: string; photo_url: string; caption: string | null; created_at: string }>(
        `INSERT INTO group_photos (group_id, user_id, photo_url, caption, drive_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, photo_url, caption, created_at`,
        [groupId, userId, photoUrl, caption ?? null, driveId ?? null],
      );
      return reply.status(201).send({ photo: result.rows[0] });
    },
  );
}
