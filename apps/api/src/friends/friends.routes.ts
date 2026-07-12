import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter, friendRequestLimiter } from '../middleware/rateLimiter';

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

// ---------------------------------------------------------------------------
// Helper: check if a block exists in either direction between two users
// (Req 17.11). Exported so other route modules (e.g. nearby.routes.ts) can
// reuse the same block-detection logic rather than reimplementing it.
// ---------------------------------------------------------------------------
export async function isBlocked(db: Pool, userA: string, userB: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM friendships
     WHERE status = 'blocked'
       AND ((requester_id = $1 AND addressee_id = $2)
         OR (requester_id = $2 AND addressee_id = $1))
     LIMIT 1`,
    [userA, userB],
  );
  return (result.rowCount ?? 0) > 0;
}

async function friendsRoutes(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /friends/invite-link — generate a deep-link invite (Req 17.1, 17.2)
  // -------------------------------------------------------------------------
  fastify.get('/friends/invite-link', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const link = `convoy://invite?userId=${encodeURIComponent(userId)}`;
    return reply.send({ inviteLink: link, qrData: link });
  });

  // -------------------------------------------------------------------------
  // GET /friends/search?q= — search users by display name (Req 17.2)
  // Returns users who are not blocked by/blocking the requester, max 20.
  // -------------------------------------------------------------------------
  fastify.get('/friends/search', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { q } = request.query as { q?: string };

    if (!q || q.trim().length < 2) {
      return reply.badRequest('Search query must be at least 2 characters');
    }
    if (q.trim().length > 100) {
      return reply.badRequest('Search query too long (max 100 characters)');
    }

    const term = `%${q.trim()}%`;

    const result = await fastify.db.query<UserPublic & { friendship_status: string | null }>(
      `SELECT u.id, u.display_name, u.avatar_url, u.ptt_callsign, u.privacy,
              f.status AS friendship_status
       FROM users u
       LEFT JOIN friendships f
         ON (f.requester_id = $1 AND f.addressee_id = u.id)
         OR (f.requester_id = u.id AND f.addressee_id = $1)
       WHERE u.id != $1
         AND u.display_name ILIKE $2
         AND NOT EXISTS (
           SELECT 1 FROM friendships b
           WHERE b.status = 'blocked'
             AND ((b.requester_id = $1 AND b.addressee_id = u.id)
               OR (b.requester_id = u.id AND b.addressee_id = $1))
         )
       ORDER BY u.display_name ASC
       LIMIT 20`,
      [userId, term],
    );

    return reply.send({
      users: result.rows.map((r) => ({
        id: r.id,
        displayName: r.display_name,
        avatarUrl: r.avatar_url,
        pttCallsign: r.ptt_callsign,
        friendshipStatus: r.friendship_status ?? null,
      })),
    });
  });

  // -------------------------------------------------------------------------
  // POST /friends/requests — send a friend request (Req 17.3–17.7)
  // Rate limited to 20 requests per user per hour (Req 37.3) via the shared
  // friendRequestLimiter preHandler — same rl:friends:<userId> Redis key the
  // previous inline limiter used, so live counters carry over.
  // -------------------------------------------------------------------------
  fastify.post('/friends/requests', { preHandler: [authenticate, generalLimiter(fastify.redis), friendRequestLimiter(fastify.redis)] }, async (request, reply) => {
    const requesterId = (request.user as { sub: string }).sub;

    const parsed = requestBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.errors[0].message);
    }
    const { addresseeId } = parsed.data;

    if (requesterId === addresseeId) {
      return reply.badRequest('You cannot send a friend request to yourself');
    }

    // Block enforcement (Req 17.11)
    if (await isBlocked(fastify.db, requesterId, addresseeId)) {
      return reply.forbidden('Unable to send friend request');
    }

    // The "check existing relationship, then insert" pattern below is a
    // classic TOCTOU race: the `friendships` unique constraint is only on
    // (requester_id, addressee_id) *in that order*, so it does NOT stop two
    // users who request each other at the same moment (A→B and B→A racing
    // concurrently) from each passing the "no existing relationship" check
    // and both inserting — leaving two separate (and, on open-privacy
    // accounts, both "accepted") friendship rows for the same pair, which
    // then shows up as a duplicated entry in both users' friends lists.
    // A same-direction double-tap (A→B twice) hits the ordered unique
    // constraint and previously surfaced as an unhandled 500.
    //
    // Fix: serialize any concurrent request/accept/block flow for this pair
    // of users with a Postgres transaction-scoped advisory lock keyed on the
    // *unordered* pair, so only one request at a time can observe-then-insert
    // for a given pair — no schema migration required.
    const [lo, hi] = [requesterId, addresseeId].sort();
    const client = await fastify.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`friendship:${lo}:${hi}`]);

      // Re-check for existing relationship now that we hold the pair lock.
      const existing = await client.query<FriendshipRow>(
        `SELECT id, status FROM friendships
         WHERE (requester_id = $1 AND addressee_id = $2)
            OR (requester_id = $2 AND addressee_id = $1)
         LIMIT 1`,
        [requesterId, addresseeId],
      );
      if (existing.rows[0]) {
        await client.query('ROLLBACK');
        const { status } = existing.rows[0];
        if (status === 'accepted') return reply.conflict('You are already friends');
        if (status === 'pending') return reply.conflict('A friend request already exists');
        return reply.forbidden('Unable to send friend request');
      }

      // Read the addressee's privacy setting
      const addresseeResult = await client.query<{ privacy: string }>(
        `SELECT privacy FROM users WHERE id = $1`,
        [addresseeId],
      );
      if (!addresseeResult.rows[0]) {
        await client.query('ROLLBACK');
        return reply.notFound('User not found');
      }

      // Privacy-based auto-accept (Req 17.6, 17.7)
      const initialStatus =
        addresseeResult.rows[0].privacy === 'open' ? 'accepted' : 'pending';

      const result = await client.query<FriendshipRow>(
        `INSERT INTO friendships (requester_id, addressee_id, status)
         VALUES ($1, $2, $3)
         RETURNING id, requester_id, addressee_id, status, created_at`,
        [requesterId, addresseeId, initialStatus],
      );

      await client.query('COMMIT');

      if (initialStatus === 'pending') {
        fastify.enqueueNotification({
          userId: addresseeId,
          type: 'friend_request',
          title: 'New Friend Request',
          body: 'You have a new friend request',
          data: { friendshipId: result.rows[0].id },
        }).catch((err: unknown) => fastify.log.error({ err }, 'notify friend_request failed'));
      }

      return reply.status(201).send({
        id: result.rows[0].id,
        status: result.rows[0].status,
        autoAccepted: initialStatus === 'accepted',
      });
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      // Defense in depth: if a duplicate somehow still slips through (e.g. a
      // request racing the /friends/block path, which isn't covered by this
      // lock), report it as a conflict instead of a raw 500.
      if ((err as { code?: string }).code === '23505') {
        return reply.conflict('A friend request already exists');
      }
      throw err;
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // GET /friends/requests — incoming pending requests (Req 17.7)
  // -------------------------------------------------------------------------
  fastify.get('/friends/requests', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const result = await fastify.db.query<
      FriendshipRow & { display_name: string; avatar_url: string | null; ptt_callsign: string | null; mutual_count: string }
    >(
      `SELECT f.id, f.requester_id, f.addressee_id, f.status, f.created_at,
              u.display_name, u.avatar_url, u.ptt_callsign,
              (
                SELECT COUNT(*) FROM (
                  SELECT CASE WHEN a.requester_id = u.id THEN a.addressee_id ELSE a.requester_id END AS uid
                  FROM friendships a WHERE a.status = 'accepted' AND (a.requester_id = u.id OR a.addressee_id = u.id)
                  INTERSECT
                  SELECT CASE WHEN b.requester_id = $1 THEN b.addressee_id ELSE b.requester_id END
                  FROM friendships b WHERE b.status = 'accepted' AND (b.requester_id = $1 OR b.addressee_id = $1)
                ) shared
              )::text AS mutual_count
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
        callsign: r.ptt_callsign,
        mutualCount: parseInt(r.mutual_count, 10),
        createdAt: r.created_at,
      })),
    });
  });

  // -------------------------------------------------------------------------
  // POST /friends/requests/:id/accept (Req 17.8)
  // -------------------------------------------------------------------------
  fastify.post(
    '/friends/requests/:id/accept',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
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

      fastify.enqueueNotification({
        userId: result.rows[0].requester_id,
        type: 'friend_request',
        title: 'Friend Request Accepted',
        body: 'Your friend request was accepted',
        data: { friendshipId: result.rows[0].id },
      }).catch((err: unknown) => fastify.log.error({ err }, 'notify friend_accept failed'));

      return reply.send({ id: result.rows[0].id, status: 'accepted' });
    },
  );

  // -------------------------------------------------------------------------
  // POST /friends/requests/:id/decline — delete silently (Req 17.9)
  // -------------------------------------------------------------------------
  fastify.post(
    '/friends/requests/:id/decline',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const { id } = request.params as { id: string };

      const result = await fastify.db.query(
        `DELETE FROM friendships
         WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
         RETURNING id`,
        [id, userId],
      );

      if ((result.rowCount ?? 0) === 0) {
        return reply.notFound('Friend request not found');
      }

      return reply.status(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // GET /friends — list accepted friends (both directions) (Req 17.1)
  // -------------------------------------------------------------------------
  fastify.get('/friends', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
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
        id: r.friendship_id,       // used by mobile for DELETE /friends/:id
        friendshipId: r.friendship_id,
        userId: r.id,
        displayName: r.display_name,
        avatarUrl: r.avatar_url,
        callsign: r.ptt_callsign,
        privacy: r.privacy,
        friendsSince: r.created_at,
      })),
    });
  });

  // -------------------------------------------------------------------------
  // GET /friends/locations — cached live locations of accepted friends who
  // have opted into groupless location sharing (Task #69).
  //
  // A friend is only included when ALL of the following hold:
  //   * the friendship is 'accepted' (either direction — blocks delete the
  //     friendship, so 'accepted' inherently excludes blocked pairs), and
  //   * that friend's user_settings.share_location_with_friends = true, and
  //   * they have a non-expired cached location in Redis under
  //     loc:friend:<userId> (written by the groupless location:update socket
  //     path with a ~35s TTL — see src/socket/socket.handler.ts).
  // Friends with the toggle off, or whose cache has expired, are omitted
  // entirely (never returned as null/stale entries).
  // -------------------------------------------------------------------------
  fastify.get('/friends/locations', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    // Accepted friends (both directions) who have opted into location sharing.
    // The user_settings JOIN is a hard DB-level gate so a friend who has never
    // opted in (or has opted out) is filtered out before we ever touch Redis.
    const friendsResult = await fastify.db.query<{
      id: string;
      display_name: string;
      avatar_url: string | null;
    }>(
      `SELECT u.id, u.display_name, u.avatar_url
       FROM friendships f
       JOIN users u ON u.id = CASE
         WHEN f.requester_id = $1 THEN f.addressee_id
         ELSE f.requester_id
       END
       JOIN user_settings s ON s.user_id = u.id
       WHERE f.status = 'accepted'
         AND (f.requester_id = $1 OR f.addressee_id = $1)
         AND s.share_location_with_friends = true
       ORDER BY u.display_name ASC`,
      [userId],
    );

    // Read each opted-in friend's latest cached fix. ioredis returns {} for a
    // missing/expired key, so an expired TTL naturally drops the friend below.
    const cached = await Promise.all(
      friendsResult.rows.map((friend) =>
        fastify.redis.hgetall(`loc:friend:${friend.id}`),
      ),
    );

    const locations = friendsResult.rows.flatMap((friend, i) => {
      const raw = cached[i];
      if (!raw || !raw.ts) return [];
      return [{
        userId: friend.id,
        displayName: friend.display_name,
        avatarUrl: friend.avatar_url,
        lat: Number(raw.lat),
        lng: Number(raw.lng),
        heading: Number(raw.heading),
        speedKph: Number(raw.speed_kph),
        ts: Number(raw.ts),
      }];
    });

    return reply.send({ locations });
  });

  // -------------------------------------------------------------------------
  // DELETE /friends/:id — remove a friend by friendship ID (Req 17.10)
  // Bidirectional: deleting the row removes it from both users' lists.
  // -------------------------------------------------------------------------
  fastify.delete('/friends/:id', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
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

    if ((result.rowCount ?? 0) === 0) {
      return reply.notFound('Friendship not found');
    }

    return reply.status(204).send();
  });

  // -------------------------------------------------------------------------
  // POST /friends/block — block a user (Req 17.11)
  // Removes any existing friendship/request then writes blocked row.
  // -------------------------------------------------------------------------
  fastify.post('/friends/block', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
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

      // Defense in depth (Task #87): proactively kick the blocked user out of
      // any DM-type group they currently share with the blocker, so an
      // existing 1:1 conversation is severed immediately and permanently
      // rather than relying solely on the message-time check in
      // POST /groups/:id/messages. Scoped to type='dm' groups only — this
      // must never remove anyone from a real multi-person convoy group.
      await client.query(
        `UPDATE convoy_members
         SET left_at = now()
         WHERE user_id = $2
           AND left_at IS NULL
           AND group_id IN (
             SELECT g.id FROM convoy_groups g
             JOIN convoy_members m1 ON m1.group_id = g.id AND m1.user_id = $1 AND m1.left_at IS NULL
             JOIN convoy_members m2 ON m2.group_id = g.id AND m2.user_id = $2 AND m2.left_at IS NULL
             WHERE g.type = 'dm'
           )`,
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

  // -------------------------------------------------------------------------
  // GET /friends/blocked — list users the current user has blocked (Req 17.11)
  // Only returns blocks the current user initiated (requester_id = self) —
  // being blocked by someone else never appears in your own blocked list.
  // -------------------------------------------------------------------------
  fastify.get('/friends/blocked', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const result = await fastify.db.query<
      { friendship_id: string; created_at: Date } & UserPublic
    >(
      `SELECT f.id AS friendship_id, f.created_at,
              u.id, u.display_name, u.avatar_url, u.ptt_callsign, u.privacy
       FROM friendships f
       JOIN users u ON u.id = f.addressee_id
       WHERE f.status = 'blocked' AND f.requester_id = $1
       ORDER BY u.display_name ASC`,
      [userId],
    );

    return reply.send({
      blocked: result.rows.map((r) => ({
        id: r.friendship_id,
        userId: r.id,
        displayName: r.display_name,
        avatarUrl: r.avatar_url,
        callsign: r.ptt_callsign,
        blockedAt: r.created_at,
      })),
    });
  });

  // -------------------------------------------------------------------------
  // POST /friends/unblock — reverse a block the current user placed (Req 17.11)
  // Only removes a block the current user is the requester of — you cannot
  // unblock someone who has blocked you.
  // -------------------------------------------------------------------------
  fastify.post('/friends/unblock', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const parsed = blockBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.errors[0].message);
    }
    const { userId: blockedId } = parsed.data;

    const result = await fastify.db.query(
      `DELETE FROM friendships
       WHERE requester_id = $1 AND addressee_id = $2 AND status = 'blocked'`,
      [userId, blockedId],
    );

    if ((result.rowCount ?? 0) === 0) {
      return reply.notFound('Block not found');
    }

    return reply.status(200).send({ message: 'User unblocked' });
  });

  // -------------------------------------------------------------------------
  // GET /friends/requests/sent — outgoing pending requests the current user sent
  // -------------------------------------------------------------------------
  fastify.get('/friends/requests/sent', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const result = await fastify.db.query<
      FriendshipRow & { display_name: string; avatar_url: string | null }
    >(
      `SELECT f.id, f.requester_id, f.addressee_id, f.status, f.created_at,
              u.display_name, u.avatar_url
       FROM friendships f
       JOIN users u ON u.id = f.addressee_id
       WHERE f.requester_id = $1 AND f.status = 'pending'
       ORDER BY f.created_at DESC`,
      [userId],
    );

    return reply.send({
      requests: result.rows.map((r) => ({
        id: r.id,
        addresseeId: r.addressee_id,
        displayName: r.display_name,
        avatarUrl: r.avatar_url,
        createdAt: r.created_at,
      })),
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /friends/requests/:id — cancel a pending outgoing request
  // -------------------------------------------------------------------------
  fastify.delete('/friends/requests/:id', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };

    const result = await fastify.db.query(
      `DELETE FROM friendships
       WHERE id = $1 AND requester_id = $2 AND status = 'pending'
       RETURNING id`,
      [id, userId],
    );

    if ((result.rowCount ?? 0) === 0) {
      return reply.notFound('Pending request not found');
    }

    return reply.status(204).send();
  });
}

export default friendsRoutes;

