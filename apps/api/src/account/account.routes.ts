/**
 * Account management, data privacy and compliance.
 * Requirements: 36.2, 36.3, 42.1–42.4
 */

import { FastifyPluginAsync } from 'fastify';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';

const accountRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /account/export ───────────────────────────────────────────────────
  // GDPR Article 20 data export (Req 42.4)
  fastify.get('/account/export', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const [userResult, drivesResult, friendsResult] = await Promise.all([
      fastify.db.query<{
        id: string; display_name: string; phone_number: string | null;
        email: string | null; avatar_url: string | null; ptt_callsign: string | null;
        privacy: string; created_at: Date;
      }>(
        `SELECT id, display_name, phone_number, email, avatar_url,
                ptt_callsign, privacy, created_at
         FROM users WHERE id = $1`,
        [userId],
      ),
      fastify.db.query<{
        id: string; group_id: string | null; route_trace: unknown;
        distance_m: number; duration_s: number;
        started_at: Date; ended_at: Date; member_count: number;
      }>(
        `SELECT id, group_id, route_trace, distance_m, duration_s,
                started_at, ended_at, member_count
         FROM drive_history WHERE user_id = $1 ORDER BY ended_at DESC`,
        [userId],
      ),
      fastify.db.query<{ friend_id: string; status: string; created_at: Date }>(
        `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS friend_id,
                status, created_at
         FROM friendships WHERE (requester_id = $1 OR addressee_id = $1) AND status = 'accepted'`,
        [userId],
      ),
    ]);

    const exportData = {
      exportedAt: new Date().toISOString(),
      profile: userResult.rows[0] ?? null,
      driveHistory: drivesResult.rows.map((d) => ({
        id: d.id,
        groupId: d.group_id,
        routeTrace: d.route_trace,
        distanceM: d.distance_m,
        durationS: d.duration_s,
        startedAt: d.started_at.toISOString(),
        endedAt: d.ended_at.toISOString(),
        memberCount: d.member_count,
      })),
      friends: friendsResult.rows.map((f) => ({
        friendId: f.friend_id,
        since: f.created_at.toISOString(),
      })),
    };

    reply.header('Content-Disposition', 'attachment; filename="convoy-data-export.json"');
    reply.header('Content-Type', 'application/json');
    return reply.send(exportData);
  });

  // ── DELETE /account ───────────────────────────────────────────────────────
  // Hard-delete all user data within 30 days — executes immediately (Req 36.3)
  fastify.delete('/account', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const client = await fastify.db.connect();
    try {
      await client.query('BEGIN');

      // convoy_groups.admin_id has no ON DELETE CASCADE, and this must be resolved
      // for groups of ANY status (not just 'active') — a group the user ended or
      // left earlier still has admin_id = userId and will block the DELETE below.
      const adminGroupsResult = await client.query<{ id: string }>(
        `SELECT id FROM convoy_groups WHERE admin_id = $1`,
        [userId],
      );

      for (const { id: groupId } of adminGroupsResult.rows) {
        // Prefer a currently-active member; fall back to any past member so we
        // can still resolve admin_id on groups that have already ended.
        const nextAdmin = await client.query<{ user_id: string }>(
          `SELECT user_id FROM convoy_members
           WHERE group_id = $1 AND user_id != $2
           ORDER BY (left_at IS NULL) DESC, joined_at ASC LIMIT 1`,
          [groupId, userId],
        );

        if (nextAdmin.rows[0]) {
          // Transfer admin to the next member — the group (if still active)
          // keeps running under its new admin, matching prior behavior.
          await client.query(
            `UPDATE convoy_groups SET admin_id = $1 WHERE id = $2`,
            [nextAdmin.rows[0].user_id, groupId],
          );
        } else {
          // User is, and always was, the sole member — this group is exclusively
          // their data. drive_history.group_id has no ON DELETE CASCADE, so null
          // it out (those rows belong solely to this user and are removed below
          // when the user row cascades) before dropping the group itself.
          await client.query(`UPDATE drive_history SET group_id = NULL WHERE group_id = $1`, [groupId]);
          await client.query(`DELETE FROM convoy_groups WHERE id = $1`, [groupId]);

          // Notify any open socket connections
          fastify.io.to(`group:${groupId}`).emit('group:ended', { endedBy: userId, groupId });
          // Clean up fuel-tracking Redis keys
          fastify.redis.del(`group:${groupId}:started_at`, `group:${groupId}:distance_m`)
            .catch(() => {});
        }
      }

      // hazard_reports.reporter_id, hazard_votes.user_id, ptt_log.user_id and
      // rally_points.broadcaster_id have no ON DELETE CASCADE either — these are
      // exactly the "reports" and "location history" Req 36.3 requires be hard
      // deleted, so remove them explicitly rather than merely unblocking the FK.
      await client.query('DELETE FROM hazard_votes WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM hazard_reports WHERE reporter_id = $1', [userId]);
      await client.query('DELETE FROM ptt_log WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM rally_points WHERE broadcaster_id = $1', [userId]);

      // Now safe to delete — cascade handles auth_providers, devices, vehicles,
      // convoy_members, ptt_channel_members, drive_history, user_settings
      await client.query('DELETE FROM users WHERE id = $1', [userId]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Invalidate refresh token jti and clear cookie
    await fastify.redis.del(`rtk:${userId}`);
    reply.clearCookie('refreshToken', { path: '/' });

    return reply.send({ success: true, message: 'Account and all associated data deleted.' });
  });

  // ── GET /legal/privacy-policy ─────────────────────────────────────────────
  // Returns the URL to the privacy policy (Req 36.2)
  fastify.get('/legal/privacy-policy', async (_request, reply) => {
    return reply.send({ url: 'https://convoy.app/legal/privacy-policy' });
  });

  // ── GET /legal/terms ──────────────────────────────────────────────────────
  fastify.get('/legal/terms', async (_request, reply) => {
    return reply.send({ url: 'https://convoy.app/legal/terms' });
  });
};

export default accountRoutes;

