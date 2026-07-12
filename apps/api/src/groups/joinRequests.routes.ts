import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter, joinRequestLimiter } from '../middleware/rateLimiter';

// ---------------------------------------------------------------------------
// Join Requests — admin-approval flow for invite-only groups.
//
// Invite-only groups (convoy_groups.access_type = 'invite_only') previously
// had no join path at all: both POST /groups/join (by code) and
// POST /groups/:id/members (direct) return 403 for invite-only groups. This
// file adds the missing route: a user requests to join, the group's admin
// sees pending requests and approves/rejects them — mirroring the existing
// friend-request accept/decline pattern (see friends/friends.routes.ts).
// ---------------------------------------------------------------------------

interface GroupRow {
  id: string;
  admin_id: string;
  access_type: 'open' | 'invite_only';
  status: 'active' | 'ended';
}

interface JoinRequestRow {
  id: string;
  group_id: string;
  user_id: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
}

async function joinRequestsRoutes(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  // -------------------------------------------------------------------------
  // POST /groups/:id/join-request — request to join an invite-only group
  // Rate limited to 10 join requests per user per hour (Req 37.4).
  // -------------------------------------------------------------------------
  fastify.post(
    '/groups/:id/join-request',
    { preHandler: [authenticate, generalLimiter(fastify.redis), joinRequestLimiter(fastify.redis)] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const { id } = request.params as { id: string };

      const groupResult = await fastify.db.query<GroupRow>(
        `SELECT id, admin_id, access_type, status FROM convoy_groups WHERE id = $1`,
        [id],
      );
      const group = groupResult.rows[0];
      if (!group) return reply.notFound('Group not found');
      if (group.status !== 'active') return reply.gone('This group has ended');

      // Open groups have a working direct-join route already — join requests
      // are only meaningful (and only necessary) for invite-only groups.
      if (group.access_type !== 'invite_only') {
        return reply.badRequest('This group is open — use the direct join endpoint');
      }

      // Already a member? No need to request.
      const memberCheck = await fastify.db.query(
        `SELECT 1 FROM convoy_members WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL`,
        [id, userId],
      );
      if ((memberCheck.rowCount ?? 0) > 0) {
        return reply.conflict('Already a member of this group');
      }

      // Already has a pending request?
      const pendingCheck = await fastify.db.query(
        `SELECT 1 FROM group_join_requests WHERE group_id = $1 AND user_id = $2 AND status = 'pending'`,
        [id, userId],
      );
      if ((pendingCheck.rowCount ?? 0) > 0) {
        return reply.conflict('You already have a pending request to join this group');
      }

      let requestRow: JoinRequestRow;
      try {
        const insertResult = await fastify.db.query<JoinRequestRow>(
          `INSERT INTO group_join_requests (group_id, user_id, status)
           VALUES ($1, $2, 'pending')
           RETURNING id, group_id, user_id, status, created_at, resolved_at, resolved_by`,
          [id, userId],
        );
        requestRow = insertResult.rows[0];
      } catch (err: unknown) {
        // Defense in depth against the (group_id, user_id) WHERE status='pending'
        // partial unique index — a concurrent double-tap races the check above.
        if ((err as { code?: string }).code === '23505') {
          return reply.conflict('You already have a pending request to join this group');
        }
        throw err;
      }

      // Notify the admin of the new request (best-effort — never block the response)
      fastify.enqueueNotification({
        userId: group.admin_id,
        type: 'group_invite',
        title: 'New Join Request',
        body: 'Someone wants to join your group',
        data: { groupId: id, requestId: requestRow.id },
      }).catch((err: unknown) => fastify.log.error({ err }, 'notify group join_request failed'));

      return reply.status(201).send({
        id: requestRow.id,
        groupId: requestRow.group_id,
        userId: requestRow.user_id,
        status: requestRow.status,
        createdAt: requestRow.created_at,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /groups/:id/join-requests — admin-only, list pending requests
  // -------------------------------------------------------------------------
  fastify.get(
    '/groups/:id/join-requests',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const { id } = request.params as { id: string };

      const groupResult = await fastify.db.query<GroupRow>(
        `SELECT id, admin_id, access_type, status FROM convoy_groups WHERE id = $1`,
        [id],
      );
      const group = groupResult.rows[0];
      if (!group) return reply.notFound('Group not found');
      if (group.admin_id !== userId) return reply.forbidden('Only the Admin can view join requests');

      const result = await fastify.db.query<
        JoinRequestRow & { display_name: string; avatar_url: string | null; ptt_callsign: string | null }
      >(
        `SELECT r.id, r.group_id, r.user_id, r.status, r.created_at, r.resolved_at, r.resolved_by,
                u.display_name, u.avatar_url, u.ptt_callsign
         FROM group_join_requests r
         JOIN users u ON u.id = r.user_id
         WHERE r.group_id = $1 AND r.status = 'pending'
         ORDER BY r.created_at ASC`,
        [id],
      );

      return reply.send({
        requests: result.rows.map((r) => ({
          id: r.id,
          groupId: r.group_id,
          userId: r.user_id,
          displayName: r.display_name,
          avatarUrl: r.avatar_url,
          callsign: r.ptt_callsign,
          status: r.status,
          createdAt: r.created_at,
        })),
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /groups/:id/join-requests/:requestId/approve — admin-only
  // -------------------------------------------------------------------------
  fastify.post(
    '/groups/:id/join-requests/:requestId/approve',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const adminUserId = (request.user as { sub: string }).sub;
      const { id, requestId } = request.params as { id: string; requestId: string };

      const groupResult = await fastify.db.query<GroupRow>(
        `SELECT id, admin_id, access_type, status FROM convoy_groups WHERE id = $1`,
        [id],
      );
      const group = groupResult.rows[0];
      if (!group) return reply.notFound('Group not found');
      if (group.admin_id !== adminUserId) return reply.forbidden('Only the Admin can approve join requests');
      if (group.status !== 'active') return reply.gone('Group is not active');

      let approvedUserId: string;

      const client = await fastify.db.connect();
      try {
        await client.query('BEGIN');

        // Lock and validate the request row is still pending
        const reqResult = await client.query<JoinRequestRow>(
          `SELECT id, group_id, user_id, status FROM group_join_requests
           WHERE id = $1 AND group_id = $2
           FOR UPDATE`,
          [requestId, id],
        );
        const joinRequest = reqResult.rows[0];
        if (!joinRequest) {
          await client.query('ROLLBACK');
          return reply.notFound('Join request not found');
        }
        if (joinRequest.status !== 'pending') {
          await client.query('ROLLBACK');
          return reply.conflict('This request has already been resolved');
        }

        approvedUserId = joinRequest.user_id;

        // Create the membership row (handles rejoin after a previous leave)
        await client.query(
          `INSERT INTO convoy_members (group_id, user_id)
           VALUES ($1, $2)
           ON CONFLICT (group_id, user_id) DO UPDATE SET left_at = NULL, joined_at = now()`,
          [id, approvedUserId],
        );

        // Add to the "All" PTT channel, same as every other join path
        await client.query(
          `INSERT INTO ptt_channel_members (channel_id, user_id)
           SELECT c.id, $2 FROM ptt_channels c
           WHERE c.group_id = $1 AND c.is_all = true
           ON CONFLICT DO NOTHING`,
          [id, approvedUserId],
        );

        // Mark this request approved
        await client.query(
          `UPDATE group_join_requests
           SET status = 'approved', resolved_at = now(), resolved_by = $1
           WHERE id = $2`,
          [adminUserId, requestId],
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      fastify.enqueueNotification({
        userId: approvedUserId,
        type: 'group_invite',
        title: 'Join Request Approved',
        body: 'Your request to join the group was approved',
        data: { groupId: id, requestId },
      }).catch((err: unknown) => fastify.log.error({ err }, 'notify join_request approve failed'));

      return reply.status(200).send({ id: requestId, status: 'approved' });
    },
  );

  // -------------------------------------------------------------------------
  // POST /groups/:id/join-requests/:requestId/reject — admin-only
  // -------------------------------------------------------------------------
  fastify.post(
    '/groups/:id/join-requests/:requestId/reject',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const adminUserId = (request.user as { sub: string }).sub;
      const { id, requestId } = request.params as { id: string; requestId: string };

      const groupResult = await fastify.db.query<GroupRow>(
        `SELECT id, admin_id FROM convoy_groups WHERE id = $1`,
        [id],
      );
      const group = groupResult.rows[0];
      if (!group) return reply.notFound('Group not found');
      if (group.admin_id !== adminUserId) return reply.forbidden('Only the Admin can reject join requests');

      const result = await fastify.db.query<JoinRequestRow>(
        `UPDATE group_join_requests
         SET status = 'rejected', resolved_at = now(), resolved_by = $1
         WHERE id = $2 AND group_id = $3 AND status = 'pending'
         RETURNING id, user_id`,
        [adminUserId, requestId, id],
      );

      const rejected = result.rows[0];
      if (!rejected) return reply.notFound('Join request not found or already resolved');

      fastify.enqueueNotification({
        userId: rejected.user_id,
        type: 'group_invite',
        title: 'Join Request Declined',
        body: 'Your request to join the group was declined',
        data: { groupId: id, requestId },
      }).catch((err: unknown) => fastify.log.error({ err }, 'notify join_request reject failed'));

      return reply.status(200).send({ id: requestId, status: 'rejected' });
    },
  );
}

export default joinRequestsRoutes;
