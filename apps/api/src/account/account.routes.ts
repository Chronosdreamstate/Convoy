/**
 * Account management, data privacy and compliance.
 * Requirements: 36.2, 36.3, 42.1–42.4
 */

import { FastifyPluginAsync } from 'fastify';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';
import { refreshTokenSetKey, legacyRefreshTokenKey } from '../auth/auth.service';
import { createStorage, uploadFilenameFromUrl } from '../uploads/storage';

// ---------------------------------------------------------------------------
// Force-disconnect every socket in a room. Same helper (and same deliberately
// defensive shape) as the one POST /groups/:id/leave uses: the socket handler's
// `location:update` listener resolves the group once at connect time and never
// re-checks it, so a still-open connection keeps broadcasting GPS to the convoy
// until the client itself happens to notice. That is unacceptable on a leave;
// it is worse for an account that no longer exists.
//
// `io` is typed loosely and the call is optional-chained because unit tests
// inject a minimal `{ to() }` mock that doesn't implement `.in()` — this is
// best-effort cleanup, not required for the route's own correctness.
// ---------------------------------------------------------------------------
function disconnectRoomSockets(io: unknown, room: string): void {
  try {
    const broadcaster = io as { in?: (room: string) => { disconnectSockets?: (close?: boolean) => void } };
    broadcaster.in?.(room)?.disconnectSockets?.(true);
  } catch { /* best-effort */ }
}

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

    // Groups whose remaining members must be told this member is gone, and the
    // uploaded files that go with the account — both collected inside the
    // transaction below, because convoy_members / group_photos / vehicles all
    // cascade away with the user row and are unreadable afterwards.
    let notifyLeftGroupIds: string[] = [];
    let uploadedFilenames: string[] = [];

    const client = await fastify.db.connect();
    try {
      await client.query('BEGIN');

      // Every file this account put in our own upload store: profile photo,
      // Garage vehicle photos, group photos, voice messages. Their DB rows
      // cascade with the user, but the files themselves live outside Postgres —
      // without this they stay on disk (or in the bucket) forever AND stay
      // downloadable at their immutable public URL, so a deleted user's face is
      // still served to anyone who kept the link. Req 36.3 asks for a hard
      // delete of the user's data; a row-only delete isn't one.
      const fileUrls = await client.query<{ url: string | null }>(
        `SELECT avatar_url AS url FROM users WHERE id = $1
         UNION ALL SELECT photo_url FROM vehicles WHERE user_id = $1
         UNION ALL SELECT photo_url FROM group_photos WHERE user_id = $1
         UNION ALL SELECT audio_url FROM group_messages WHERE user_id = $1`,
        [userId],
      );
      uploadedFilenames = [
        ...new Set(
          fileUrls.rows
            .map((r) => uploadFilenameFromUrl(r.url))
            .filter((f): f is string => f !== null),
        ),
      ];

      // Convoys this account is still actively in. Deleting the user hard-deletes
      // their convoy_members row, but nothing tells the other members: the
      // roster/map is driven by the member:left socket event (ConvoyScreen /
      // ConvoyLobbyScreen), so without it the deleted member's card and map pin
      // stay on everyone else's screen — name, avatar and all — until they
      // navigate away and refetch. Same event POST /groups/:id/leave emits for
      // the same reason (Req 7.7). DM channels are excluded: they have no
      // roster UI and no member:left listener.
      const activeMemberships = await client.query<{ group_id: string }>(
        `SELECT m.group_id FROM convoy_members m
         JOIN convoy_groups g ON g.id = m.group_id
         WHERE m.user_id = $1 AND m.left_at IS NULL AND g.type = 'group'`,
        [userId],
      );
      notifyLeftGroupIds = activeMemberships.rows.map((r) => r.group_id);

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

          // The group is gone, so `group:ended` below is the departure signal —
          // don't also send member:left for it (same rule as the leave route).
          notifyLeftGroupIds = notifyLeftGroupIds.filter((id) => id !== groupId);

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

    // Invalidate every live refresh token for the deleted account — the whole
    // set, i.e. all of the user's devices — and clear this device's cookie.
    // `rtk:` is the pre-multi-device key, cleared too so a token issued before
    // that change cannot outlive the account.
    await fastify.redis.del(refreshTokenSetKey(userId));
    await fastify.redis.del(legacyRefreshTokenKey(userId));
    reply.clearCookie('refreshToken', { path: '/' });

    // Explicitly purge the groupless friend-location cache too (Task #69 /
    // Req 36.3 "hard-delete ... immediately"). The 35s TTL would clear this on
    // its own, and the cascaded delete of users/user_settings/friendships
    // above already makes GET /friends/locations unable to ever serve it
    // again — but relying on either of those for a compliance-sensitive
    // "delete now" flow is exactly the kind of implicit/incidental protection
    // this review is meant to flag, so delete it up front like the other
    // per-user Redis keys cleaned up in this handler.
    await fastify.redis.del(`loc:friend:${userId}`).catch((err: unknown) => {
      fastify.log.error({ err }, 'failed to delete loc:friend key on account deletion');
    });

    // Tell every convoy this account was still in that the member is gone, so
    // the roster and map pin disappear now rather than on the next refetch.
    for (const groupId of notifyLeftGroupIds) {
      fastify.io.to(`group:${groupId}`).emit('member:left', { userId });
    }

    // ...and cut the deleted account's own sockets, so a client that hasn't yet
    // torn down its connection cannot keep broadcasting location into the
    // convoy it was just removed from. This also runs socket.handler.ts's
    // disconnect cleanup, which clears the `loc:<groupId>:<userId>` caches and
    // flips the member offline for everyone else.
    disconnectRoomSockets(fastify.io, `user:${userId}`);

    // Finally the files themselves. Best-effort and after the commit: the
    // account is already gone, and a storage hiccup must not turn a completed
    // deletion into a 500 the client will retry.
    if (uploadedFilenames.length > 0) {
      try {
        const storage = createStorage();
        await Promise.all(uploadedFilenames.map((name) => storage.remove(name)));
      } catch (err: unknown) {
        fastify.log.error({ err }, 'failed to remove uploaded files on account deletion');
      }
    }

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

