import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const sendMessageSchema = z
  .object({
    type: z.enum(['text', 'voice']).default('text'),
    text: z.string().min(1, 'Message cannot be empty').max(500, 'Message exceeds 500 characters').optional(),
    audioUrl: z.string().url().optional(),
  })
  .refine(
    (d) => (d.type === 'voice' ? !!d.audioUrl : !!d.text),
    { message: 'Text messages require text; voice messages require audioUrl' },
  );

const fetchMessagesSchema = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(50),
});

const reactSchema = z.object({
  emoji: z.string().min(1).max(8),
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
  text: string | null;
  type: string;
  audio_url: string | null;
  created_at: Date;
  reactions: { emoji: string; user_ids: string[] }[] | null;
}

interface InsertedMessageRow {
  id: string;
  group_id: string;
  user_id: string;
  text: string | null;
  type: string;
  audio_url: string | null;
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

      const reactionsSubquery = `
        (SELECT COALESCE(json_agg(json_build_object('emoji', r.emoji, 'user_ids', r.uids)), '[]'::json)
         FROM (
           SELECT emoji, json_agg(user_id::text) AS uids
           FROM message_reactions
           WHERE message_id = gm.id
           GROUP BY emoji
         ) r
        ) AS reactions`;

      if (before) {
        const beforeDate = new Date(before);
        if (isNaN(beforeDate.getTime())) {
          return reply.badRequest('before must be a valid ISO date string');
        }
        const result = await fastify.db.query<MessageRow>(
          `SELECT gm.id, gm.group_id, gm.user_id,
                  u.display_name, u.avatar_url,
                  gm.text, gm.type, gm.audio_url, gm.created_at,
                  ${reactionsSubquery}
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
                  gm.text, gm.type, gm.audio_url, gm.created_at,
                  ${reactionsSubquery}
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
        text: row.text ?? null,
        type: row.type,
        audioUrl: row.audio_url ?? null,
        createdAt: row.created_at,
        reactions: (row.reactions ?? []).map((r) => ({
          emoji: r.emoji,
          userIds: r.user_ids,
        })),
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

      const { type, text, audioUrl } = parsed.data;

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
        `INSERT INTO group_messages (group_id, user_id, text, type, audio_url)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, group_id, user_id, text, type, audio_url, created_at`,
        [id, userId, text ?? null, type, audioUrl ?? null],
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
        text: msg.text ?? null,
        type: msg.type,
        audioUrl: msg.audio_url ?? null,
        createdAt: msg.created_at,
      };

      // Broadcast to all sockets in the group room
      fastify.io.to(`group:${id}`).emit('group:message', payload);

      return reply.status(201).send(payload);
    },
  );

  // -------------------------------------------------------------------------
  // POST /groups/:id/messages/:messageId/react — add reaction
  // DELETE /groups/:id/messages/:messageId/react — remove reaction
  // -------------------------------------------------------------------------
  async function handleReact(
    request: FastifyRequest,
    reply: FastifyReply,
    action: 'add' | 'remove',
  ) {
    const userId = (request.user as { sub: string }).sub;
    const { id, messageId } = request.params as { id: string; messageId: string };

    const parsed = reactSchema.safeParse(request.body);
    if (!parsed.success) return reply.badRequest(parsed.error.errors[0].message);
    const { emoji } = parsed.data;

    // Verify membership
    const memberCheck = await fastify.db.query(
      `SELECT 1 FROM convoy_members WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [id, userId],
    );
    if ((memberCheck.rowCount ?? 0) === 0) return reply.forbidden('You are not a member of this group');

    // Verify message belongs to this group
    const msgCheck = await fastify.db.query(
      'SELECT id FROM group_messages WHERE id = $1 AND group_id = $2',
      [messageId, id],
    );
    if ((msgCheck.rowCount ?? 0) === 0) return reply.notFound('Message not found');

    if (action === 'add') {
      await fastify.db.query(
        `INSERT INTO message_reactions (message_id, user_id, emoji)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [messageId, userId, emoji],
      );
    } else {
      await fastify.db.query(
        `DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
        [messageId, userId, emoji],
      );
    }

    fastify.io.to(`group:${id}`).emit('group:reaction', { messageId, userId, emoji, action });
    return reply.status(204).send();
  }

  fastify.post(
    '/groups/:id/messages/:messageId/react',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    (req, reply) => handleReact(req, reply, 'add'),
  );

  fastify.delete(
    '/groups/:id/messages/:messageId/react',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    (req, reply) => handleReact(req, reply, 'remove'),
  );
}

export default chatRoutes;
