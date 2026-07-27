import { FastifyInstance } from 'fastify';
import { Server as SocketIO } from 'socket.io';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';

const openDmSchema = z.object({
  friendId: z.string().uuid(),
});

/**
 * Normalize a DM participant pair to a canonical order.
 *
 * Returns the two user ids lowercased and sorted so that result[0] < result[1].
 * This MUST match Postgres uuid ordering, because migration 033 backfills
 * dm_user_a/dm_user_b with LEAST(user_id)/GREATEST(user_id): Postgres compares
 * uuids byte-wise, which for the canonical lowercase hex representation is
 * exactly lexicographic string order (hyphens occupy identical positions in
 * both strings, so they never affect the comparison). Exported for property
 * tests.
 */
export function normalizeDmPair(a: string, b: string): [string, string] {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? [x, y] : [y, x];
}

/**
 * Join every open socket of the given users to the DM channel's room, so a
 * freshly created (or newly re-opened) DM starts receiving `group:message` /
 * `group:reaction` broadcasts immediately — without waiting for the users'
 * next socket reconnect (connect-time DM room join lives in
 * socket/socket.handler.ts). `socketsJoin` on a room filter is propagated
 * cluster-wide by the Redis adapter, so this is correct across nodes.
 */
export function joinDmRoomSockets(io: SocketIO, groupId: string, userIds: string[]): void {
  try {
    for (const uid of userIds) {
      io.in(`user:${uid}`).socketsJoin(`group:${groupId}`);
    }
  } catch {
    // Non-fatal (and lets unit tests decorate a minimal io mock): the users'
    // sockets still join the room on their next reconnect.
  }
}

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

    const [dmUserA, dmUserB] = normalizeDmPair(userId, friendId);

    // Fast path: pair-column lookup (unique-indexed since migration 033).
    const byPair = await fastify.db.query<{ id: string }>(
      `SELECT id FROM convoy_groups
       WHERE type = 'dm' AND dm_user_a = $1 AND dm_user_b = $2`,
      [dmUserA, dmUserB],
    );
    if ((byPair.rowCount ?? 0) > 0) {
      const groupId = byPair.rows[0].id;
      // Reactivate memberships in case a prior block soft-removed one/both rows
      // (POST /friends/block sets left_at on the shared DM). Without this, a DM
      // re-opened after unblock + re-friend hands back a groupId whose members
      // are still left_at != NULL, so the membership-gated message endpoints
      // silently 403 and the conversation appears broken.
      await fastify.db.query(
        `INSERT INTO convoy_members (group_id, user_id) VALUES ($1, $2), ($1, $3)
         ON CONFLICT (group_id, user_id) DO UPDATE SET left_at = NULL`,
        [groupId, userId, friendId],
      );
      joinDmRoomSockets(fastify.io, groupId, [userId, friendId]);
      return reply.send({ groupId });
    }

    // Legacy fallback: DM channels that never got pair columns stamped (e.g.
    // pre-033 duplicates that lost the backfill dedupe, or channels created
    // by routes not yet writing the pair columns). Matched by membership.
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
      const groupId = existing.rows[0].id;
      joinDmRoomSockets(fastify.io, groupId, [userId, friendId]);
      return reply.send({ groupId });
    }

    // Create new DM channel — retry up to 5 times on join_code collision.
    //
    // Concurrency: uq_convoy_groups_dm_pair (migration 033) guarantees at most
    // one stamped DM row per normalized pair. ON CONFLICT on that index makes
    // a concurrent duplicate create return zero rows instead of erroring —
    // in which case the other request's row is committed and visible, and we
    // converge on it below. A join_code collision hits the table's separate
    // UNIQUE constraint, still raises 23505, and is retried as before.
    let groupId: string | null = null;
    let lostCreationRace = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const joinCode = randomBytes(3).toString('hex').toUpperCase();
      try {
        const result = await fastify.db.query<{ id: string }>(
          `INSERT INTO convoy_groups (name, join_code, admin_id, access_type, type, dm_user_a, dm_user_b)
           VALUES ('dm', $1, $2, 'invite_only', 'dm', $3, $4)
           ON CONFLICT (dm_user_a, dm_user_b)
             WHERE type = 'dm' AND dm_user_a IS NOT NULL AND dm_user_b IS NOT NULL
             DO NOTHING
           RETURNING id`,
          [joinCode, userId, dmUserA, dmUserB],
        );
        if ((result.rowCount ?? 0) === 0) {
          lostCreationRace = true;
        } else {
          groupId = result.rows[0].id;
        }
        break;
      } catch (err: unknown) {
        if ((err as { code?: string }).code !== '23505') throw err; // only retry on unique violation
      }
    }

    if (lostCreationRace) {
      // A concurrent POST /dm for the same pair won the insert; its row is
      // committed by the time ON CONFLICT resolves. Converge on it.
      const winner = await fastify.db.query<{ id: string }>(
        `SELECT id FROM convoy_groups
         WHERE type = 'dm' AND dm_user_a = $1 AND dm_user_b = $2`,
        [dmUserA, dmUserB],
      );
      if ((winner.rowCount ?? 0) === 0) return reply.internalServerError('Could not create DM channel');
      const winnerId = winner.rows[0].id;
      // The winning request inserts memberships in a separate statement after
      // its group insert commits — make sure they exist before we hand this
      // groupId to a client that will immediately fetch messages (membership-
      // gated). Idempotent via UNIQUE (group_id, user_id).
      await fastify.db.query(
        `INSERT INTO convoy_members (group_id, user_id) VALUES ($1, $2), ($1, $3)
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        [winnerId, userId, friendId],
      );
      joinDmRoomSockets(fastify.io, winnerId, [userId, friendId]);
      return reply.send({ groupId: winnerId });
    }

    if (!groupId) return reply.internalServerError('Could not create DM channel');

    await fastify.db.query(
      `INSERT INTO convoy_members (group_id, user_id) VALUES ($1, $2), ($1, $3)
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [groupId, userId, friendId],
    );

    // Pull both users' live sockets into the new channel's room right away.
    joinDmRoomSockets(fastify.io, groupId, [userId, friendId]);

    return reply.status(201).send({ groupId });
  });
}
