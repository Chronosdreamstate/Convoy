/**
 * Account management, data privacy and compliance.
 * Requirements: 36.2, 36.3, 42.1–42.4
 */

import { FastifyPluginAsync } from 'fastify';

const accountRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /account/export ───────────────────────────────────────────────────
  // GDPR Article 20 data export (Req 42.4)
  fastify.get('/account/export', async (request, reply) => {
    await request.jwtVerify();
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
  fastify.delete('/account', async (request, reply) => {
    await request.jwtVerify();
    const userId = (request.user as { sub: string }).sub;

    // Cascade deletes handle all linked records (users has ON DELETE CASCADE)
    await fastify.db.query('DELETE FROM users WHERE id = $1', [userId]);

    // Clear refresh-token cookie so the client can't reuse the old session
    reply.clearCookie('refresh_token', { path: '/api/v1/auth/refresh' });

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
