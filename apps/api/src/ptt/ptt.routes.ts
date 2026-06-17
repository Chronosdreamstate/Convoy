/**
 * PTT channel management and Agora token endpoint.
 * Requirements: 10.1, 26.1–26.7, 38.2
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { RtcTokenBuilder, RtcRole } from 'agora-token';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { env } from '../config/env';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PTT_TOKEN_TTL_S = 4 * 60 * 60; // 4 hours (Req 38.2)

// ---------------------------------------------------------------------------
// Pure helper functions — exported for property testing
// ---------------------------------------------------------------------------

/**
 * Converts a UUID userId to a deterministic uint32 Agora UID.
 * Agora requires a non-zero uint32 UID.
 */
export function userIdToAgoraUid(userId: string): number {
  const hex = userId.replace(/-/g, '');
  let h = 5381;
  for (let i = 0; i < hex.length; i += 2) {
    h = (Math.imul(h, 33) + parseInt(hex.slice(i, i + 2), 16)) | 0;
  }
  const uid = (h >>> 0) || 1; // ensure non-zero
  return uid;
}

/**
 * Channel name scoped to a group and channel (sent to Agora).
 * SHA-256 hash keeps it under Agora's 64-byte limit while avoiding collisions.
 */
export function buildAgoraChannelName(groupId: string, channelId: string): string {
  return createHash('sha256').update(`${groupId}:${channelId}`).digest('hex').slice(0, 32);
}

/**
 * Returns true if the member is permitted to transmit PTT audio.
 * Property 15: non-member → false. Property 17: muted → false.
 */
export function canTransmit(params: { isActiveMember: boolean; isMuted: boolean }): boolean {
  return params.isActiveMember && !params.isMuted;
}

/**
 * Returns true when a transmission has run at or past its time limit.
 * Property 16: used by the server to detect over-limit transmissions.
 */
export function isDurationExceeded(
  startedAtMs: number,
  nowMs: number,
  maxSeconds: number,
): boolean {
  return (nowMs - startedAtMs) / 1000 >= maxSeconds;
}

/** Returns false for the "All" channel so it can never be deleted. Property 42. */
export function canDeleteChannel(channel: { is_all: boolean }): boolean {
  return !channel.is_all;
}

/**
 * Returns the set of user IDs that should receive a PTT transmission.
 * Property 43: non-all channel → only channelMemberIds.
 * Property 44: "All" channel → every active member.
 */
export function getChannelRecipients(
  allMemberIds: string[],
  channelMemberIds: string[],
  isAllChannel: boolean,
): string[] {
  return isAllChannel ? [...allMemberIds] : [...channelMemberIds];
}

/** Returns true if the user is an active group member (allowed to read PTT log). Property 47. */
export function canViewPttLog(isActiveMember: boolean): boolean {
  return isActiveMember;
}

/**
 * Returns a new array of PTT log entries sorted by startedAt ascending.
 * Property 49: entries always presented oldest-first.
 */
export function sortPttLogAscending<T extends { startedAt: number }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Returns a new Map where userId maps to exactly newValue, removing any prior entry.
 * Property 45: each member belongs to exactly one PTT channel at a time.
 */
export function enforceExactlyOneChannel<T>(
  memberships: Map<string, T>,
  userId: string,
  newValue: T,
): Map<string, T> {
  const updated = new Map(memberships);
  updated.set(userId, newValue);
  return updated;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Generate a real Agora RTC token via agora-token SDK. Falls back to a dev placeholder. */
function generateAgoraToken(channelName: string, uid: number, ttlSeconds: number): string {
  if (!env.AGORA_APP_ID || !env.AGORA_APP_CERTIFICATE) {
    return `dev-token-${channelName}-${uid}-${ttlSeconds}`;
  }
  return RtcTokenBuilder.buildTokenWithUid(
    env.AGORA_APP_ID,
    env.AGORA_APP_CERTIFICATE,
    channelName,
    uid,
    RtcRole.PUBLISHER,
    ttlSeconds,
    ttlSeconds,
  );
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const tokenBodySchema = z.object({
  groupId: z.string().uuid(),
  channelId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default async function pttRoutes(fastify: FastifyInstance): Promise<void> {
  const pool: Pool = fastify.db;

  // -------------------------------------------------------------------------
  // POST /ptt/token — generate short-lived Agora RTC token (Req 38.2)
  // -------------------------------------------------------------------------
  fastify.post('/ptt/token', { preHandler: authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const parsed = tokenBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.badRequest('groupId and channelId must be valid UUIDs');
    const { groupId, channelId } = parsed.data;

    // Verify active membership (Req 10.1)
    const memberResult = await pool.query<{ is_muted: boolean }>(
      `SELECT is_muted FROM convoy_members
       WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [groupId, userId],
    );
    const member = memberResult.rows[0];
    if (!member) return reply.forbidden('You are not an active member of this group');
    if (!canTransmit({ isActiveMember: true, isMuted: member.is_muted })) {
      return reply.forbidden('You are muted and cannot transmit');
    }

    // Verify channel belongs to group
    const channelResult = await pool.query<{ id: string; is_all: boolean }>(
      'SELECT id, is_all FROM ptt_channels WHERE id = $1 AND group_id = $2',
      [channelId, groupId],
    );
    if (!channelResult.rows[0]) return reply.notFound('Channel not found in this group');

    const uid = userIdToAgoraUid(userId);
    const channelName = buildAgoraChannelName(groupId, channelId);
    const token = generateAgoraToken(channelName, uid, PTT_TOKEN_TTL_S);
    const expiresAt = new Date(Date.now() + PTT_TOKEN_TTL_S * 1000).toISOString();

    return { token, uid, channelName, expiresAt };
  });

  // -------------------------------------------------------------------------
  // GET /groups/:id/channels — list PTT channels (Req 26.1)
  // -------------------------------------------------------------------------
  fastify.get('/groups/:id/channels', { preHandler: authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };

    const member = await pool.query(
      'SELECT 1 FROM convoy_members WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL',
      [id, userId],
    );
    if ((member.rowCount ?? 0) === 0) return reply.forbidden('Not a member of this group');

    const result = await pool.query<{
      id: string; name: string; is_all: boolean; member_count: string;
    }>(
      `SELECT c.id, c.name, c.is_all, COUNT(cm.user_id) AS member_count
       FROM ptt_channels c
       LEFT JOIN ptt_channel_members cm ON cm.channel_id = c.id
       WHERE c.group_id = $1
       GROUP BY c.id
       ORDER BY c.is_all DESC, c.name ASC`,
      [id],
    );

    return result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      isAll: r.is_all,
      memberCount: parseInt(r.member_count, 10),
    }));
  });

  // -------------------------------------------------------------------------
  // POST /groups/:id/channels — create a PTT channel (Req 26.1, admin only)
  // -------------------------------------------------------------------------
  fastify.post('/groups/:id/channels', { preHandler: authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const { name } = request.body as { name: string };

    if (!name?.trim()) return reply.badRequest('Channel name is required');
    if (name.trim().length > 100) return reply.badRequest('Channel name cannot exceed 100 characters');

    const group = await pool.query<{ admin_id: string }>(
      'SELECT admin_id FROM convoy_groups WHERE id = $1 AND status = $2',
      [id, 'active'],
    );
    if (!group.rows[0]) return reply.notFound('Group not found or ended');
    if (group.rows[0].admin_id !== userId) return reply.forbidden('Only the Admin can create channels');

    const result = await pool.query<{ id: string; name: string; is_all: boolean }>(
      `INSERT INTO ptt_channels (group_id, name, is_all) VALUES ($1, $2, false)
       RETURNING id, name, is_all`,
      [id, name.trim()],
    );

    return reply.code(201).send({
      id: result.rows[0].id,
      name: result.rows[0].name,
      isAll: result.rows[0].is_all,
      memberCount: 0,
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /groups/:id/channels/:channelId — rename channel (admin only)
  // -------------------------------------------------------------------------
  fastify.patch(
    '/groups/:id/channels/:channelId',
    { preHandler: authenticate },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const { id, channelId } = request.params as { id: string; channelId: string };
      const { name } = request.body as { name: string };

      if (!name?.trim()) return reply.badRequest('Channel name is required');
      if (name.trim().length > 100) return reply.badRequest('Channel name cannot exceed 100 characters');

      const group = await pool.query<{ admin_id: string; status: string }>(
        'SELECT admin_id, status FROM convoy_groups WHERE id = $1',
        [id],
      );
      if (!group.rows[0]) return reply.notFound('Group not found');
      if (group.rows[0].status !== 'active') return reply.gone('Group is already ended');
      if (group.rows[0].admin_id !== userId) return reply.forbidden('Only the Admin can rename channels');

      const existingChannel = await pool.query<{ is_all: boolean }>(
        'SELECT is_all FROM ptt_channels WHERE id = $1 AND group_id = $2',
        [channelId, id],
      );
      if (!existingChannel.rows[0]) return reply.notFound('Channel not found');
      if (existingChannel.rows[0].is_all) return reply.badRequest('The "All" channel cannot be renamed');

      const result = await pool.query<{ id: string; name: string; is_all: boolean }>(
        `UPDATE ptt_channels SET name = $1 WHERE id = $2 AND group_id = $3
         RETURNING id, name, is_all`,
        [name.trim(), channelId, id],
      );
      if ((result.rowCount ?? 0) === 0) return reply.notFound('Channel not found');

      return { id: result.rows[0].id, name: result.rows[0].name, isAll: result.rows[0].is_all };
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /groups/:id/channels/:channelId — delete channel (admin; blocks "All") Req 26.2
  // -------------------------------------------------------------------------
  fastify.delete(
    '/groups/:id/channels/:channelId',
    { preHandler: authenticate },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const { id, channelId } = request.params as { id: string; channelId: string };

      const group = await pool.query<{ admin_id: string }>(
        'SELECT admin_id FROM convoy_groups WHERE id = $1',
        [id],
      );
      if (!group.rows[0]) return reply.notFound('Group not found');
      if (group.rows[0].admin_id !== userId) return reply.forbidden('Only the Admin can delete channels');

      const channel = await pool.query<{ id: string; is_all: boolean }>(
        'SELECT id, is_all FROM ptt_channels WHERE id = $1 AND group_id = $2',
        [channelId, id],
      );
      if (!channel.rows[0]) return reply.notFound('Channel not found');

      if (!canDeleteChannel(channel.rows[0])) {
        return reply.badRequest('The "All" channel cannot be deleted');
      }

      // Move channel members to "All" before deleting
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const allChannel = await client.query<{ id: string }>(
          'SELECT id FROM ptt_channels WHERE group_id = $1 AND is_all = true',
          [id],
        );
        if (allChannel.rows[0]) {
          await client.query(
            `INSERT INTO ptt_channel_members (channel_id, user_id)
             SELECT $1, user_id FROM ptt_channel_members WHERE channel_id = $2
             ON CONFLICT DO NOTHING`,
            [allChannel.rows[0].id, channelId],
          );
        }
        await client.query('DELETE FROM ptt_channels WHERE id = $1', [channelId]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      return reply.code(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // POST /groups/:id/channels/:channelId/join — switch channel (Req 26.6, Property 45)
  // -------------------------------------------------------------------------
  fastify.post(
    '/groups/:id/channels/:channelId/join',
    { preHandler: authenticate },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const { id, channelId } = request.params as { id: string; channelId: string };

      const member = await pool.query(
        'SELECT 1 FROM convoy_members WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL',
        [id, userId],
      );
      if ((member.rowCount ?? 0) === 0) return reply.forbidden('Not an active member');

      const channel = await pool.query(
        'SELECT 1 FROM ptt_channels WHERE id = $1 AND group_id = $2',
        [channelId, id],
      );
      if ((channel.rowCount ?? 0) === 0) return reply.notFound('Channel not found');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Remove from all channels in this group (enforces exactly-one invariant)
        await client.query(
          `DELETE FROM ptt_channel_members
           WHERE user_id = $1 AND channel_id IN (
             SELECT id FROM ptt_channels WHERE group_id = $2
           )`,
          [userId, id],
        );

        // Add to the new channel
        await client.query(
          'INSERT INTO ptt_channel_members (channel_id, user_id) VALUES ($1, $2)',
          [channelId, userId],
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      return reply.code(200).send({ channelId });
    },
  );

  // -------------------------------------------------------------------------
  // GET /groups/:id/ptt-log — PTT log for this session (Req 27.1–27.5)
  // -------------------------------------------------------------------------
  fastify.get('/groups/:id/ptt-log', { preHandler: authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };

    const member = await pool.query(
      'SELECT 1 FROM convoy_members WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL',
      [id, userId],
    );
    if (!canViewPttLog((member.rowCount ?? 0) > 0)) {
      return reply.forbidden('Only active group members can view the PTT log');
    }

    const result = await pool.query<{
      id: string; user_id: string; channel_id: string | null;
      started_at: Date; display_name: string; ptt_callsign: string | null;
    }>(
      `SELECT l.id, l.user_id, l.channel_id, l.started_at,
              u.display_name, u.ptt_callsign
       FROM ptt_log l
       JOIN users u ON u.id = l.user_id
       WHERE l.group_id = $1
       ORDER BY l.started_at ASC`,
      [id],
    );

    return result.rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      channelId: r.channel_id,
      startedAt: r.started_at.toISOString(),
      displayName: r.display_name,
      callsign: r.ptt_callsign,
    }));
  });
}
