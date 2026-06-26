import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const JOIN_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const JOIN_RATE_LIMIT_MAX = 10;
const JOIN_RATE_LIMIT_WINDOW = 3600; // 1 hour

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const createGroupSchema = z.object({
  name: z.string().min(1).max(100),
  accessType: z.enum(['open', 'invite_only']).optional().default('open'),
});

const joinGroupSchema = z.object({
  code: z.string().length(6),
});

const patchSettingsSchema = z.object({
  gapThresholdM: z.number().int().min(100).max(160000).optional(),
  pttMaxSeconds: z.number().int().min(5).max(60).optional(),
  accessType: z.enum(['open', 'invite_only']).optional(),
});

const muteSchema = z.object({
  muted: z.boolean(),
});

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------
interface GroupRow {
  id: string;
  name: string;
  join_code: string;
  admin_id: string;
  access_type: 'open' | 'invite_only';
  status: 'active' | 'ended';
  gap_threshold_m: number;
  ptt_max_seconds: number;
  created_at: Date;
  ended_at: Date | null;
}

interface MemberRow {
  id: string;
  group_id: string;
  user_id: string;
  joined_at: Date;
  left_at: Date | null;
  is_muted: boolean;
  display_name?: string;
  avatar_url?: string | null;
  ptt_callsign?: string | null;
  vehicle_year?: number | null;
  vehicle_make?: string | null;
  vehicle_model?: string | null;
  vehicle_color?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a unique 6-char alphanumeric join code (retries up to 5×). */
async function generateJoinCode(pool: Pool): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += JOIN_CODE_CHARS[Math.floor(Math.random() * JOIN_CODE_CHARS.length)];
    }
    const check = await pool.query(
      'SELECT 1 FROM convoy_groups WHERE join_code = $1',
      [code],
    );
    if ((check.rowCount ?? 0) === 0) return code;
  }
  throw new Error('Failed to generate a unique join code — please retry');
}

/** Return the active membership row for a user in a group, or null. */
async function getActiveMember(
  groupId: string,
  userId: string,
  pool: Pool,
): Promise<MemberRow | null> {
  const result = await pool.query<MemberRow>(
    `SELECT id, group_id, user_id, joined_at, left_at, is_muted
     FROM convoy_members
     WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [groupId, userId],
  );
  return result.rows[0] ?? null;
}

function groupToResponse(g: GroupRow, memberCount?: number) {
  return {
    id: g.id,
    name: g.name,
    joinCode: g.status === 'active' ? g.join_code : null,
    adminId: g.admin_id,
    accessType: g.access_type,
    status: g.status,
    gapThresholdM: g.gap_threshold_m,
    pttMaxSeconds: g.ptt_max_seconds,
    createdAt: g.created_at,
    endedAt: g.ended_at,
    ...(memberCount !== undefined && { memberCount }),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
async function groupsRoutes(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {

  // -------------------------------------------------------------------------
  // POST /groups — create group (Req 7.1, 7.2)
  // -------------------------------------------------------------------------
  fastify.post('/groups', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const adminId = (request.user as { sub: string }).sub;

    const parsed = createGroupSchema.safeParse(request.body);
    if (!parsed.success) return reply.badRequest(parsed.error.errors[0].message);

    const { name, accessType } = parsed.data;
    const joinCode = await generateJoinCode(fastify.db);

    const client = await fastify.db.connect();
    try {
      await client.query('BEGIN');

      // Create the group
      const groupResult = await client.query<GroupRow>(
        `INSERT INTO convoy_groups (name, join_code, admin_id, access_type)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, join_code, admin_id, access_type, status,
                   gap_threshold_m, ptt_max_seconds, created_at, ended_at`,
        [name, joinCode, adminId, accessType],
      );
      const group = groupResult.rows[0];

      // Add creator as first active member
      await client.query(
        `INSERT INTO convoy_members (group_id, user_id) VALUES ($1, $2)`,
        [group.id, adminId],
      );

      // Auto-create the "All" PTT channel (Req 26.2)
      const channelResult = await client.query<{ id: string }>(
        `INSERT INTO ptt_channels (group_id, name, is_all) VALUES ($1, 'All', true)
         RETURNING id`,
        [group.id],
      );

      // Add creator to "All" channel
      await client.query(
        `INSERT INTO ptt_channel_members (channel_id, user_id) VALUES ($1, $2)`,
        [channelResult.rows[0].id, adminId],
      );

      await client.query('COMMIT');

      // Record session start time in Redis for fuel suggestion duration tracking (Req 21.1)
      await fastify.redis.set(
        `group:${group.id}:started_at`,
        String(Date.now()),
        'EX',
        86_400, // 24-hour TTL — group sessions won't run longer than this
      );

      return reply.status(201).send(groupToResponse(group, 1));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // GET /groups/active — the caller's current active group, or null (Req 7.6)
  // Used by mobile to restore group state after an app restart.
  // Must be registered before /:id to avoid the UUID param matching "active".
  // -------------------------------------------------------------------------
  fastify.get('/groups/active', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const result = await fastify.db.query<GroupRow & { member_count: string }>(
      `SELECT g.id, g.name, g.join_code, g.admin_id, g.access_type, g.status,
              g.gap_threshold_m, g.ptt_max_seconds, g.created_at, g.ended_at,
              COUNT(m2.id) FILTER (WHERE m2.left_at IS NULL) AS member_count
       FROM convoy_members m
       JOIN convoy_groups g ON g.id = m.group_id
       LEFT JOIN convoy_members m2 ON m2.group_id = g.id
       WHERE m.user_id = $1
         AND m.left_at IS NULL
         AND g.status = 'active'
       GROUP BY g.id
       LIMIT 1`,
      [userId],
    );

    if (result.rows.length === 0) {
      return reply.send({ group: null });
    }

    const g = result.rows[0];
    return reply.send({ group: groupToResponse(g, parseInt(g.member_count, 10)) });
  });

  // -------------------------------------------------------------------------
  // GET /groups/public — list open groups for discovery (must be before /:id)
  // -------------------------------------------------------------------------
  fastify.get('/groups/public', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const result = await fastify.db.query<GroupRow & { member_count: string }>(
      `SELECT g.id, g.name, g.join_code, g.admin_id, g.access_type, g.status,
              g.gap_threshold_m, g.ptt_max_seconds, g.created_at, g.ended_at,
              COUNT(m.id) FILTER (WHERE m.left_at IS NULL) AS member_count
       FROM convoy_groups g
       LEFT JOIN convoy_members m ON m.group_id = g.id
       WHERE g.access_type = 'open' AND g.status = 'active'
       GROUP BY g.id
       ORDER BY member_count DESC, g.created_at DESC
       LIMIT 50`,
      [],
    );

    return reply.send({
      groups: result.rows.map((g) => groupToResponse(g, parseInt(g.member_count, 10))),
    });
  });

  // -------------------------------------------------------------------------
  // GET /groups/:id — get group details
  // -------------------------------------------------------------------------
  fastify.get('/groups/:id', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };

    const member = await getActiveMember(id, userId, fastify.db);
    if (!member) return reply.forbidden('You are not a member of this group');

    const result = await fastify.db.query<GroupRow & { member_count: string }>(
      `SELECT g.id, g.name, g.join_code, g.admin_id, g.access_type, g.status,
              g.gap_threshold_m, g.ptt_max_seconds, g.created_at, g.ended_at,
              COUNT(m.id) FILTER (WHERE m.left_at IS NULL) AS member_count
       FROM convoy_groups g
       LEFT JOIN convoy_members m ON m.group_id = g.id
       WHERE g.id = $1
       GROUP BY g.id`,
      [id],
    );

    const g = result.rows[0];
    if (!g) return reply.notFound('Group not found');

    return reply.send(groupToResponse(g, parseInt(g.member_count, 10)));
  });

  // -------------------------------------------------------------------------
  // POST /groups/join — join by code (Req 7.4, 7.5, 37.4, 38.1)
  // -------------------------------------------------------------------------
  fastify.post('/groups/join', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const parsed = joinGroupSchema.safeParse(request.body);
    if (!parsed.success) return reply.badRequest(parsed.error.errors[0].message);

    const { code } = parsed.data;

    // Rate limit: 10 join attempts per user per hour
    const rlKey = `rl:group-join:${userId}`;
    const count = await fastify.redis.incr(rlKey);
    if (count === 1) await fastify.redis.expire(rlKey, JOIN_RATE_LIMIT_WINDOW);
    if (count > JOIN_RATE_LIMIT_MAX) {
      return reply.tooManyRequests('Too many join attempts. Please try again later.');
    }

    // Find the group by join code
    const groupResult = await fastify.db.query<GroupRow>(
      `SELECT id, name, join_code, admin_id, access_type, status,
              gap_threshold_m, ptt_max_seconds, created_at, ended_at
       FROM convoy_groups
       WHERE join_code = $1`,
      [code.toUpperCase()],
    );

    const group = groupResult.rows[0];
    if (!group) return reply.notFound('Invalid join code');

    // Join code expires when group ends (Req 38.1)
    if (group.status !== 'active') {
      return reply.gone('This group has ended');
    }

    // Invite-only enforcement (Req 7.5, Property 11)
    if (group.access_type === 'invite_only') {
      return reply.forbidden('This group is invite-only');
    }

    // Check if already an active member — idempotent: return 200 with current group data
    const existing = await getActiveMember(group.id, userId, fastify.db);
    if (existing) {
      const countResult = await fastify.db.query<{ member_count: string }>(
        `SELECT COUNT(*) FILTER (WHERE left_at IS NULL) AS member_count
         FROM convoy_members WHERE group_id = $1`,
        [group.id],
      );
      const memberCount = parseInt(countResult.rows[0]?.member_count ?? '0', 10);
      return reply.status(200).send(groupToResponse(group, memberCount));
    }

    const client = await fastify.db.connect();
    try {
      await client.query('BEGIN');

      // Lock the group row to prevent a concurrent end-group from slipping in before the INSERT
      const lockResult = await client.query<{ status: string }>(
        'SELECT status FROM convoy_groups WHERE id = $1 FOR UPDATE',
        [group.id],
      );
      if (lockResult.rows[0]?.status !== 'active') {
        await client.query('ROLLBACK');
        return reply.gone('This group has ended');
      }

      // Upsert member row (handles rejoin after leaving)
      await client.query(
        `INSERT INTO convoy_members (group_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (group_id, user_id) DO UPDATE SET left_at = NULL, joined_at = now()`,
        [group.id, userId],
      );

      // Add to "All" PTT channel
      await client.query(
        `INSERT INTO ptt_channel_members (channel_id, user_id)
         SELECT c.id, $2
         FROM ptt_channels c
         WHERE c.group_id = $1 AND c.is_all = true
         ON CONFLICT DO NOTHING`,
        [group.id, userId],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Fetch the current member count after joining
    const countResult = await fastify.db.query<{ member_count: string }>(
      `SELECT COUNT(*) FILTER (WHERE left_at IS NULL) AS member_count
       FROM convoy_members WHERE group_id = $1`,
      [group.id],
    );
    const memberCount = parseInt(countResult.rows[0]?.member_count ?? '0', 10);

    return reply.status(200).send(groupToResponse(group, memberCount));
  });

  // -------------------------------------------------------------------------
  // GET /groups/:id/members — list active members
  // -------------------------------------------------------------------------
  fastify.get(
    '/groups/:id/members',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const { id } = request.params as { id: string };

      const member = await getActiveMember(id, userId, fastify.db);
      if (!member) return reply.forbidden('You are not a member of this group');

      const groupResult = await fastify.db.query<{ admin_id: string }>(
        'SELECT admin_id FROM convoy_groups WHERE id = $1',
        [id],
      );
      const adminId = groupResult.rows[0]?.admin_id;

      const result = await fastify.db.query<MemberRow>(
        `SELECT m.id, m.group_id, m.user_id, m.joined_at, m.left_at, m.is_muted,
                u.display_name, u.avatar_url, u.ptt_callsign,
                v.year AS vehicle_year, v.make AS vehicle_make,
                v.model AS vehicle_model, v.color AS vehicle_color
         FROM convoy_members m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN vehicles v ON v.user_id = m.user_id AND v.is_active = true
         WHERE m.group_id = $1 AND m.left_at IS NULL
         ORDER BY m.joined_at ASC`,
        [id],
      );

      return reply.send({
        members: result.rows.map((m) => ({
          id: m.id,
          userId: m.user_id,
          displayName: m.display_name,
          avatarUrl: m.avatar_url,
          pttCallsign: m.ptt_callsign,
          isAdmin: m.user_id === adminId,
          isMuted: m.is_muted,
          joinedAt: m.joined_at,
          vehicle: (m.vehicle_make || m.vehicle_model)
            ? {
                year: m.vehicle_year ?? null,
                make: m.vehicle_make ?? null,
                model: m.vehicle_model ?? null,
                color: m.vehicle_color ?? null,
              }
            : null,
        })),
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /groups/:id/leave — leave group (Req 7.7, 7.8)
  // -------------------------------------------------------------------------
  fastify.post('/groups/:id/leave', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };

    const member = await getActiveMember(id, userId, fastify.db);
    if (!member) return reply.forbidden('You are not a member of this group');

    const groupResult = await fastify.db.query<GroupRow>(
      `SELECT id, admin_id, status FROM convoy_groups WHERE id = $1`,
      [id],
    );
    const group = groupResult.rows[0];
    if (!group || group.status !== 'active') return reply.gone('Group is not active');

    let groupEnded = false;

    const client = await fastify.db.connect();
    try {
      await client.query('BEGIN');

      // Mark member as left
      await client.query(
        `UPDATE convoy_members SET left_at = now() WHERE group_id = $1 AND user_id = $2`,
        [id, userId],
      );

      // Remove from PTT channels
      await client.query(
        `DELETE FROM ptt_channel_members
         WHERE user_id = $1 AND channel_id IN (
           SELECT id FROM ptt_channels WHERE group_id = $2
         )`,
        [userId, id],
      );

      const isAdmin = group.admin_id === userId;

      if (isAdmin) {
        // Find next admin: earliest joined_at among remaining active members (Req 7.8)
        const nextAdmin = await client.query<{ user_id: string }>(
          `SELECT user_id FROM convoy_members
           WHERE group_id = $1 AND user_id != $2 AND left_at IS NULL
           ORDER BY joined_at ASC
           LIMIT 1`,
          [id, userId],
        );

        if (nextAdmin.rows[0]) {
          // Transfer admin role (Property 12)
          await client.query(
            `UPDATE convoy_groups SET admin_id = $1 WHERE id = $2`,
            [nextAdmin.rows[0].user_id, id],
          );
        } else {
          // Admin was last member — end the group
          await client.query(
            `UPDATE convoy_groups SET status = 'ended', ended_at = now() WHERE id = $1`,
            [id],
          );
          // Clear PTT log in same transaction (Req 27.4)
          await cleanupGroupPttLog(id, client);
          groupEnded = true;
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // If the group was auto-ended because admin was last member, clean up Redis and notify
    if (groupEnded) {
      // Clear fuel-tracking and distance Redis keys
      fastify.redis
        .del(`group:${id}:started_at`, `group:${id}:distance_m`)
        .catch((err: unknown) => fastify.log.error({ err }, 'Failed to delete group Redis keys on auto-end'));

      // Notify any remaining socket connections that the group has ended
      fastify.io.to(`group:${id}`).emit('group:ended', { endedBy: userId, groupId: id });
    }

    return reply.status(200).send({ message: 'Left group' });
  });

  // -------------------------------------------------------------------------
  // POST /groups/:id/end — end group (admin only, Req 7.9)
  // -------------------------------------------------------------------------
  fastify.post('/groups/:id/end', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };

    const groupResult = await fastify.db.query<GroupRow>(
      `SELECT id, admin_id, status FROM convoy_groups WHERE id = $1`,
      [id],
    );
    const group = groupResult.rows[0];
    if (!group) return reply.notFound('Group not found');
    if (group.admin_id !== userId) return reply.forbidden('Only the Admin can end the group');
    if (group.status !== 'active') return reply.gone('Group is already ended');

    const client = await fastify.db.connect();
    try {
      await client.query('BEGIN');

      // End the group — join code is effectively expired (Req 38.1)
      await client.query(
        `UPDATE convoy_groups SET status = 'ended', ended_at = now() WHERE id = $1`,
        [id],
      );

      // Mark all active members as left (soft-close the group)
      await client.query(
        `UPDATE convoy_members SET left_at = now() WHERE group_id = $1 AND left_at IS NULL`,
        [id],
      );

      // Clear PTT log in same transaction (Req 27.4)
      await cleanupGroupPttLog(id, client);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Clean up fuel-tracking Redis keys
    fastify.redis
      .del(`group:${id}:started_at`, `group:${id}:distance_m`)
      .catch((err: unknown) => fastify.log.error({ err }, 'Failed to delete group Redis keys on end'));

    // Notify all members in the group room that the group has ended (Req 7.9)
    fastify.io.to(`group:${id}`).emit('group:ended', { endedBy: userId, groupId: id });

    return reply.status(200).send({ message: 'Group ended' });
  });

  // -------------------------------------------------------------------------
  // DELETE /groups/:id/members/:targetUserId — kick member (admin only)
  // -------------------------------------------------------------------------
  fastify.delete(
    '/groups/:id/members/:targetUserId',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const adminUserId = (request.user as { sub: string }).sub;
      const { id, targetUserId } = request.params as { id: string; targetUserId: string };

      // Prevent admin from kicking themselves
      if (targetUserId === adminUserId) {
        return reply.badRequest('Admin cannot kick themselves');
      }

      const groupResult = await fastify.db.query<{ admin_id: string; status: string }>(
        'SELECT admin_id, status FROM convoy_groups WHERE id = $1',
        [id],
      );
      const group = groupResult.rows[0];
      if (!group) return reply.notFound('Group not found');
      if (group.admin_id !== adminUserId) return reply.forbidden('Only the Admin can kick members');
      if (group.status !== 'active') return reply.gone('Group is not active');

      // Soft-delete: set left_at = now() on the target member's active row
      const result = await fastify.db.query<{ id: string }>(
        `UPDATE convoy_members
         SET left_at = now()
         WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL
         RETURNING id`,
        [id, targetUserId],
      );

      if ((result.rowCount ?? 0) === 0) {
        return reply.notFound('Member not found or already left');
      }

      // Remove kicked member from all PTT channels in this group (awaited for data integrity)
      await fastify.db
        .query(
          `DELETE FROM ptt_channel_members
           WHERE user_id = $1 AND channel_id IN (
             SELECT id FROM ptt_channels WHERE group_id = $2
           )`,
          [targetUserId, id],
        )
        .catch((err: unknown) =>
          fastify.log.error({ err }, 'Failed to remove kicked member from PTT channels'),
        );

      // Notify the kicked user on their personal socket room
      fastify.io
        .to(`user:${targetUserId}`)
        .emit('member:kicked', { groupId: id });

      return reply.status(200).send({ message: 'Member kicked' });
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /groups/:id/settings — admin only (Req 10.11, 24.3)
  // -------------------------------------------------------------------------
  fastify.patch(
    '/groups/:id/settings',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const { id } = request.params as { id: string };

      const parsed = patchSettingsSchema.safeParse(request.body);
      if (!parsed.success) return reply.badRequest(parsed.error.errors[0].message);

      const groupResult = await fastify.db.query<GroupRow>(
        `SELECT id, admin_id, status, gap_threshold_m, ptt_max_seconds, access_type
         FROM convoy_groups WHERE id = $1`,
        [id],
      );
      const group = groupResult.rows[0];
      if (!group) return reply.notFound('Group not found');
      if (group.admin_id !== userId) return reply.forbidden('Only the Admin can change settings');

      const { gapThresholdM, pttMaxSeconds, accessType } = parsed.data;

      const setClauses: string[] = [];
      const values: unknown[] = [];
      let p = 1;

      if (gapThresholdM !== undefined) { setClauses.push(`gap_threshold_m = $${p++}`); values.push(gapThresholdM); }
      if (pttMaxSeconds !== undefined) { setClauses.push(`ptt_max_seconds = $${p++}`); values.push(pttMaxSeconds); }
      if (accessType !== undefined) { setClauses.push(`access_type = $${p++}`); values.push(accessType); }

      if (setClauses.length === 0) return reply.send(groupToResponse(group));

      values.push(id);
      const result = await fastify.db.query<GroupRow>(
        `UPDATE convoy_groups SET ${setClauses.join(', ')}
         WHERE id = $${p}
         RETURNING id, name, join_code, admin_id, access_type, status,
                   gap_threshold_m, ptt_max_seconds, created_at, ended_at`,
        values,
      );

      const updated = result.rows[0];
      if (!updated) return reply.notFound('Group not found');

      return reply.send(groupToResponse(updated));
    },
  );

  // -------------------------------------------------------------------------
  // POST /groups/:id/members/mute-all — admin only (Req 10.11)
  // Must be registered before /:userId/mute so Fastify's static route wins.
  // -------------------------------------------------------------------------
  fastify.post(
    '/groups/:id/members/mute-all',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const { id } = request.params as { id: string };

      const parsed = muteSchema.safeParse(request.body);
      if (!parsed.success) return reply.badRequest(parsed.error.errors[0].message);

      const groupResult = await fastify.db.query<{ admin_id: string }>(
        'SELECT admin_id FROM convoy_groups WHERE id = $1',
        [id],
      );
      const group = groupResult.rows[0];
      if (!group) return reply.notFound('Group not found');
      if (group.admin_id !== userId) return reply.forbidden('Only the Admin can mute members');

      await fastify.db.query(
        `UPDATE convoy_members SET is_muted = $1
         WHERE group_id = $2 AND left_at IS NULL AND user_id != $3`,
        [parsed.data.muted, id, userId],
      );

      return reply.status(200).send({ message: parsed.data.muted ? 'All members muted' : 'All members unmuted' });
    },
  );

  // -------------------------------------------------------------------------
  // POST /groups/:id/members/:targetUserId/mute — admin only (Req 10.11)
  // -------------------------------------------------------------------------
  fastify.post(
    '/groups/:id/members/:targetUserId/mute',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const adminUserId = (request.user as { sub: string }).sub;
      const { id, targetUserId } = request.params as { id: string; targetUserId: string };

      const parsed = muteSchema.safeParse(request.body);
      if (!parsed.success) return reply.badRequest(parsed.error.errors[0].message);

      const groupResult = await fastify.db.query<{ admin_id: string }>(
        'SELECT admin_id FROM convoy_groups WHERE id = $1',
        [id],
      );
      const group = groupResult.rows[0];
      if (!group) return reply.notFound('Group not found');
      if (group.admin_id !== adminUserId) return reply.forbidden('Only the Admin can mute members');
      if (targetUserId === adminUserId) return reply.badRequest('Admin cannot mute themselves');

      const result = await fastify.db.query(
        `UPDATE convoy_members SET is_muted = $1
         WHERE group_id = $2 AND user_id = $3 AND left_at IS NULL
         RETURNING id`,
        [parsed.data.muted, id, targetUserId],
      );

      if ((result.rowCount ?? 0) === 0) return reply.notFound('Member not found');

      return reply.status(200).send({
        message: parsed.data.muted ? 'Member muted' : 'Member unmuted',
      });
    },
  );
}

export default groupsRoutes;

/** Delete all PTT log rows for a group — call inside the end-group transaction (Req 27.4). */
export async function cleanupGroupPttLog(
  groupId: string,
  client: { query(text: string, values: unknown[]): Promise<unknown> },
): Promise<void> {
  await client.query('DELETE FROM ptt_log WHERE group_id = $1', [groupId]);
}

