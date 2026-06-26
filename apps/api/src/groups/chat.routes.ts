import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const sendMessageSchema = z.object({
  text: z.string().min(1, 'Message cannot be empty').max(500, 'Message exceeds 500 characters'),
});

const fetchMessagesSchema = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(50),
});

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface MessageRow {
  id: string;
  group_id: string;
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  text: string;
  created_at: Date;
}

interface InsertedMessageRow {
  id: string;
  group_id: string;
  user_id: string;
  text: string;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

async function chatRoutes(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {

  // -------------------------------------------------------------------------
  // GET /groups/:id/messages?before=<ISO>&limit=50
  // Fetch last N messages (cursor-based, newest first).
  // -------------------------------------------------------------------------
  fastify.get(
    '/groups/:id/messages',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const { id } = request.params as { id: string };

      const parsed = fetchMessagesSchema.safeParse(request.query);
      if (!parsed.success) return reply.badRequest(parsed.error.errors[0].message);

      const { before, limit } = parsed.data;

      // Verify requesting user is an active member of this group
      const memberCheck = await fastify.db.query(
        `SELECT 1 FROM convoy_members WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL`,
        [id, userId],
      );
      if ((memberCheck.rowCount ?? 0) === 0) {
        return reply.forbidden('You are not a member of this group');
      }

      let rows: MessageRow[];

      if (before) {
        const beforeDate = new Date(before);
        if (isNaN(beforeDate.getTime())) {
          return reply.badRequest('before must be a valid ISO date string');
        }
        const result = await fastify.db.query<MessageRow>(
          `SELECT gm.id, gm.group_id, gm.user_id,
                  u.display_name, u.avatar_url,
                  gm.text, gm.created_at
           FROM group_messages gm
           JOIN users u ON u.id = gm.user_id
           WHERE gm.group_id = $1
             AND gm.created_at < $2
           ORDER BY gm.created_at DESC, gm.id DESC
           LIMIT $3`,
          [id, beforeDate.toISOString(), limit],
        );
        rows = result.rows;
      } else {
        const result = await fastify.db.query<MessageRow>(
          `SELECT gm.id, gm.group_id, gm.user_id,
                  u.display_name, u.avatar_url,
                  gm.text, gm.created_at
           FROM group_messages gm
           JOIN users u ON u.id = gm.user_id
           WHERE gm.group_id = $1
           ORDER BY gm.created_at DESC, gm.id DESC
           LIMIT $2`,
          [id, limit],
        );
        rows = result.rows;
      }

      const messages = rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        displayName: row.display_name,
        avatarUrl: row.avatar_url ?? null,
        text: row.text,
        createdAt: row.created_at,
      }));

      // Provide a cursor to the oldest returned message so the client can page back
      const nextCursor: string | null =
        rows.length === limit
          ? rows[rows.length - 1].created_at.toISOString()
          : null;

      return reply.send({ messages, nextCursor });
    },
  );

  // -------------------------------------------------------------------------
  // POST /groups/:id/messages
  // Send a message; broadcast via socket to the group room.
  // -------------------------------------------------------------------------
  fastify.post(
    '/groups/:id/messages',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const { id } = request.params as { id: string };

      const parsed = sendMessageSchema.safeParse(request.body);
      if (!parsed.success) return reply.badRequest(parsed.error.errors[0].message);

      const { text } = parsed.data;

      // Verify requesting user is an active member of this group
      const memberCheck = await fastify.db.query(
        `SELECT 1 FROM convoy_members WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL`,
        [id, userId],
      );
      if ((memberCheck.rowCount ?? 0) === 0) {
        return reply.forbidden('You are not a member of this group');
      }

      // Insert the message
      const insertResult = await fastify.db.query<InsertedMessageRow>(
        `INSERT INTO group_messages (group_id, user_id, text)
         VALUES ($1, $2, $3)
         RETURNING id, group_id, user_id, text, created_at`,
        [id, userId, text],
      );
      const msg = insertResult.rows[0];

      // Fetch the sender's display name and avatar for the socket payload
      const userResult = await fastify.db.query<{ display_name: string; avatar_url: string | null }>(
        'SELECT display_name, avatar_url FROM users WHERE id = $1',
        [userId],
      );
      const sender = userResult.rows[0];

      const payload = {
        id: msg.id,
        groupId: msg.group_id,
        userId: msg.user_id,
        displayName: sender?.display_name ?? '',
        avatarUrl: sender?.avatar_url ?? null,
        text: msg.text,
        createdAt: msg.created_at,
      };

      // Broadcast to all sockets in the group room
      fastify.io.to(`group:${id}`).emit('group:message', payload);

      return reply.status(201).send(payload);
    },
  );
}

export default chatRoutes;
