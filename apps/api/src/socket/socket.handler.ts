import { FastifyInstance } from 'fastify';
import { Server as SocketIO, Socket } from 'socket.io';
import { z } from 'zod';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { canTransmit, isDurationExceeded } from '../ptt/ptt.routes';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LatLng {
  lat: number;
  lng: number;
}

export interface LocationPayload {
  lat: number;
  lng: number;
  heading: number;
  speed_kph: number;
  ts: number;
}

// Minimal interface the gap-alert logic needs from socket.io
export interface IoBroadcaster {
  to(room: string): { emit(event: string, data: unknown): void };
}

const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  heading: z.number().min(0).max(360),
  speed_kph: z.number().min(0),
  ts: z.number().int().positive(),
});

const STALE_THRESHOLD_MS = 30_000; // 30 seconds (Property 40)

// ---------------------------------------------------------------------------
// Pure helper: Haversine great-circle distance in metres
// ---------------------------------------------------------------------------
export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δφ = toRad(b.lat - a.lat);
  const Δλ = toRad(b.lng - a.lng);
  const x =
    Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// ---------------------------------------------------------------------------
// Haversine distance in kilometres (inlined per spec, used for centroid gap alert)
// ---------------------------------------------------------------------------
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Core location update handler — exported for unit testing
// ---------------------------------------------------------------------------
export async function handleLocationUpdate(params: {
  groupId: string;
  userId: string;
  location: LocationPayload;
  redis: Redis;
  db: Pool;
  io: IoBroadcaster;
  /** Overridable wall-clock so property tests can inject a fixed "now". */
  now?: number;
}): Promise<void> {
  const { groupId, userId, location, redis, db, io, now = Date.now() } = params;
  const locKey = `loc:${groupId}:${userId}`;

  // 1a. Read the previous location BEFORE overwriting it (needed for distance accumulation)
  const prevLocRaw = await redis.hgetall(locKey);

  // 1b. Write new location to Redis with 35-second TTL (aligned with 30s stale threshold + buffer)
  await redis.hset(locKey, {
    lat: String(location.lat),
    lng: String(location.lng),
    heading: String(location.heading),
    speed_kph: String(location.speed_kph),
    ts: String(location.ts),
  });
  await redis.expire(locKey, 35);

  // 1c. Accumulate per-member movement into the group distance counter (fuel suggestion, Req 21.1)
  if (prevLocRaw && prevLocRaw.lat && prevLocRaw.lng) {
    const delta = haversineMeters(
      { lat: Number(prevLocRaw.lat), lng: Number(prevLocRaw.lng) },
      { lat: location.lat, lng: location.lng },
    );
    if (delta > 0) {
      const distanceKey = `group:${groupId}:distance_m`;
      await redis.incrbyfloat(distanceKey, delta);
      await redis.expire(distanceKey, 86_400); // 24-hour TTL — always refresh to avoid TOCTOU gap
    }
  }

  // 2. Fan-out to every member in the group room (Req 8.2)
  io.to(`group:${groupId}`).emit('location:update', { userId, ...location });

  // 3. Gap alert computation — non-admin members only (Req 24.1–24.6)
  const groupResult = await db.query<{ admin_id: string; gap_threshold_m: number }>(
    'SELECT admin_id, gap_threshold_m FROM convoy_groups WHERE id = $1',
    [groupId],
  );
  const group = groupResult.rows[0];
  if (!group || userId === group.admin_id) return; // Admin's own update doesn't trigger alert

  // Fetch admin's last known location
  const adminRaw = await redis.hgetall(`loc:${groupId}:${group.admin_id}`);
  if (!adminRaw || !adminRaw.ts) return; // Admin has no cached location

  // Exclude stale admin location (Property 40): skip if admin last reported > 30s ago
  const adminTs = Number(adminRaw.ts);
  if (now - adminTs > STALE_THRESHOLD_MS) return;

  const distance = haversineMeters(
    { lat: Number(adminRaw.lat), lng: Number(adminRaw.lng) },
    { lat: location.lat, lng: location.lng },
  );

  if (distance > group.gap_threshold_m) {
    // Emit gap:alert to admin's personal room only (Property 39)
    io.to(`user:${group.admin_id}`).emit('gap:alert', {
      memberId: userId,
      distanceM: Math.round(distance),
      groupId,
    });
  }

  // 4. Destination arrival notification (Req 15.3)
  const destRaw = await redis.hgetall(`route:${groupId}:dest`);
  if (destRaw?.lat && destRaw?.lng) {
    const destDist = haversineMeters(
      { lat: location.lat, lng: location.lng },
      { lat: Number(destRaw.lat), lng: Number(destRaw.lng) },
    );
    if (destDist < 200) {
      // SETNX gate — notify each member at most once per pushed route
      const arrivedKey = `arrived:${groupId}:${userId}`;
      const isFirst = await redis.set(arrivedKey, '1', 'EX', 3600, 'NX');
      if (isFirst === 'OK') {
        io.to(`user:${userId}`).emit('navigation:arrived', { groupId });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// PTT signaling — exported for property testing
// ---------------------------------------------------------------------------

export interface PttStartPayload {
  channelId: string;
}

/**
 * Handles ptt:start: verifies canTransmit, inserts ptt_log, broadcasts to recipients.
 * Returns the log row id, or null if the member cannot transmit.
 */
export async function handlePttStart(params: {
  groupId: string;
  userId: string;
  channelId: string;
  db: Pool;
  io: IoBroadcaster;
}): Promise<{ logId: string | null }> {
  const { groupId, userId, channelId, db, io } = params;

  // Verify member is active and not muted (Properties 15 & 17)
  const memberResult = await db.query<{ is_muted: boolean }>(
    `SELECT is_muted FROM convoy_members
     WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [groupId, userId],
  );
  const member = memberResult.rows[0];
  if (!member) return { logId: null };

  if (!canTransmit({ isActiveMember: true, isMuted: member.is_muted })) {
    return { logId: null };
  }

  // Fetch channel info and recipient list
  const channelResult = await db.query<{ id: string; is_all: boolean }>(
    'SELECT id, is_all FROM ptt_channels WHERE id = $1 AND group_id = $2',
    [channelId, groupId],
  );
  const channel = channelResult.rows[0];
  if (!channel) return { logId: null };

  let recipientIds: string[];
  if (channel.is_all) {
    const allResult = await db.query<{ user_id: string }>(
      'SELECT user_id FROM convoy_members WHERE group_id = $1 AND left_at IS NULL',
      [groupId],
    );
    recipientIds = allResult.rows.map((r) => r.user_id);
  } else {
    const chResult = await db.query<{ user_id: string }>(
      'SELECT user_id FROM ptt_channel_members WHERE channel_id = $1',
      [channelId],
    );
    recipientIds = chResult.rows.map((r) => r.user_id);
  }

  // Record in ptt_log
  const logResult = await db.query<{ id: string }>(
    `INSERT INTO ptt_log (group_id, user_id, channel_id) VALUES ($1, $2, $3) RETURNING id`,
    [groupId, userId, channelId],
  );
  const logId = logResult.rows[0].id;

  // Broadcast ptt:transmit to all recipients via their personal rooms (Properties 43 & 44)
  const payload = { logId, userId, channelId, groupId };
  for (const recipientId of recipientIds) {
    io.to(`user:${recipientId}`).emit('ptt:transmit', payload);
  }

  return { logId };
}

/**
 * Handles ptt:end: validates duration, broadcasts ptt:ended.
 */
export async function handlePttEnd(params: {
  groupId: string;
  userId: string;
  logId: string;
  db: Pool;
  io: IoBroadcaster;
  now?: number;
}): Promise<void> {
  const { groupId, userId, logId, db, io, now = Date.now() } = params;

  // Get the log row to find channel and validate duration — include group_id to prevent cross-group manipulation
  const logResult = await db.query<{
    id: string; channel_id: string | null; started_at: Date;
  }>(
    'SELECT id, channel_id, started_at FROM ptt_log WHERE id = $1 AND user_id = $2 AND group_id = $3',
    [logId, userId, groupId],
  );
  const log = logResult.rows[0];
  if (!log) return;

  // Stamp ended_at before computing duration
  await db.query('UPDATE ptt_log SET ended_at = NOW() WHERE id = $1', [logId]);

  const groupResult = await db.query<{ ptt_max_seconds: number }>(
    'SELECT ptt_max_seconds FROM convoy_groups WHERE id = $1',
    [groupId],
  );
  const maxSeconds = groupResult.rows[0]?.ptt_max_seconds ?? 30;

  const exceeded = isDurationExceeded(log.started_at.getTime(), now, maxSeconds);
  const durationMs = now - log.started_at.getTime();

  // Build recipient list (same logic as start)
  let recipientIds: string[];
  if (log.channel_id) {
    const channelResult = await db.query<{ is_all: boolean }>(
      'SELECT is_all FROM ptt_channels WHERE id = $1',
      [log.channel_id],
    );
    const isAll = channelResult.rows[0]?.is_all ?? false;
    if (isAll) {
      const r = await db.query<{ user_id: string }>(
        'SELECT user_id FROM convoy_members WHERE group_id = $1 AND left_at IS NULL',
        [groupId],
      );
      recipientIds = r.rows.map((rr) => rr.user_id);
    } else {
      const r = await db.query<{ user_id: string }>(
        'SELECT user_id FROM ptt_channel_members WHERE channel_id = $1',
        [log.channel_id],
      );
      recipientIds = r.rows.map((rr) => rr.user_id);
    }
  } else {
    recipientIds = [userId];
  }

  const payload = { logId, userId, groupId, durationExceeded: exceeded, durationMs };
  for (const recipientId of recipientIds) {
    io.to(`user:${recipientId}`).emit('ptt:ended', payload);
  }
}

// ---------------------------------------------------------------------------
// Hazard proximity check — emits hazard:nearby to user's personal room
// ---------------------------------------------------------------------------

export async function handleHazardProximity(params: {
  userId: string;
  location: LatLng;
  db: Pool;
  redis: Redis;
  io: IoBroadcaster;
}): Promise<void> {
  const { userId, location, db, redis, io } = params;

  const settingsResult = await db.query<{ hazard_alert_distance_m: number }>(
    'SELECT hazard_alert_distance_m FROM user_settings WHERE user_id = $1',
    [userId],
  );
  const alertDistanceM = settingsResult.rows[0]?.hazard_alert_distance_m ?? 805;

  const hazards = await db.query<{ id: string; hazard_type: string; lat: number; lng: number }>(
    `SELECT id, hazard_type,
       ST_Y(location::geometry) AS lat,
       ST_X(location::geometry) AS lng
     FROM hazard_reports
     WHERE status = 'active'
       AND expires_at > now()
       AND ST_DWithin(
         location,
         ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
         $3
       )`,
    [location.lng, location.lat, alertDistanceM],
  );

  if (hazards.rows.length === 0) return;

  // Deduplicate alerts via Redis — only notify once per hazard per user (Req 11.7)
  const alertedKey = `hazard_alerted:${userId}`;

  for (const hazard of hazards.rows) {
    // Use sadd return value as atomic gate — avoids sismember→sadd TOCTOU race
    const added = await redis.sadd(alertedKey, hazard.id);
    if (added === 0) continue;

    await redis.expire(alertedKey, 3600);

    io.to(`user:${userId}`).emit('hazard:nearby', {
      id: hazard.id,
      type: hazard.hazard_type,
      lat: hazard.lat,
      lng: hazard.lng,
    });
  }
}

// ---------------------------------------------------------------------------
// Centroid gap alert — exported for unit testing
// Emits gap:alert to the user's personal room when they are > 5 km from the
// geometric centroid of all active group members (convoy mode only).
// ---------------------------------------------------------------------------
export async function handleCentroidGapAlert(params: {
  groupId: string;
  userId: string;
  location: LatLng;
  redis: Redis;
  db: Pool;
  io: IoBroadcaster;
}): Promise<void> {
  const { groupId, userId, location, redis, db, io } = params;

  // Only run while the group is in convoy mode (status = 'active')
  const groupResult = await db.query<{ status: string }>(
    'SELECT status FROM convoy_groups WHERE id = $1',
    [groupId],
  );
  if (groupResult.rows[0]?.status !== 'active') return;

  // Gather every member's cached location from Redis
  const locKeys = await redis.keys(`loc:${groupId}:*`);
  if (locKeys.length < 2) return; // centroid needs at least 2 points

  const locs: LatLng[] = [];
  for (const key of locKeys) {
    const raw = await redis.hgetall(key);
    if (raw?.lat && raw?.lng) {
      locs.push({ lat: Number(raw.lat), lng: Number(raw.lng) });
    }
  }
  if (locs.length < 2) return;

  // Arithmetic centroid of all member positions
  const centroidLat = locs.reduce((sum, l) => sum + l.lat, 0) / locs.length;
  const centroidLng = locs.reduce((sum, l) => sum + l.lng, 0) / locs.length;

  const distKm = haversineKm(location.lat, location.lng, centroidLat, centroidLng);
  if (distKm > 5) {
    io.to(`user:${userId}`).emit('gap:alert', {
      distanceKm: Math.round(distKm * 10) / 10,
      groupId,
    });
  }
}

// ---------------------------------------------------------------------------
// Global presence store (in-memory, per-process)
// ---------------------------------------------------------------------------
interface PresenceEntry {
  isOnline: boolean;
  lastSeen: Date;
  socketId: string;
}
const presence = new Map<string, PresenceEntry>();

// ---------------------------------------------------------------------------
// Socket.io connection handler factory
// ---------------------------------------------------------------------------
export function registerSocketHandlers(
  fastify: FastifyInstance,
  io: SocketIO,
): (socket: Socket) => void {
  const lastLocUpdate = new Map<string, number>();
  const LOC_RATE_LIMIT_MS = 500; // max 2 location updates per second per socket

  return async (socket: Socket) => {
    const userId = socket.data.userId as string;
    let groupId = socket.data.groupId as string;

    if (!userId) {
      socket.disconnect(true);
      return;
    }

    // Auto-rejoin on reconnect: if groupId is absent from auth (e.g. client reconnected
    // with only a JWT), look up the user's current active group membership in the DB.
    if (!groupId) {
      const activeGroup = await fastify.db.query<{ group_id: string }>(
        `SELECT group_id FROM convoy_members WHERE user_id = $1 AND left_at IS NULL LIMIT 1`,
        [userId],
      );
      if (activeGroup.rows.length === 0) {
        socket.disconnect(true);
        return;
      }
      groupId = activeGroup.rows[0].group_id;
    }

    // Verify active membership before joining room — prevents unauthorized room access
    const memberCheck = await fastify.db.query<{ id: string }>(
      `SELECT id FROM convoy_members WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [groupId, userId],
    );
    if (memberCheck.rows.length === 0) {
      socket.disconnect(true);
      return;
    }

    // Track presence
    presence.set(userId, { isOnline: true, lastSeen: new Date(), socketId: socket.id });

    // Join group room and personal room — must be awaited before broadcasting
    await socket.join(`group:${groupId}`);
    await socket.join(`user:${userId}`);

    // Notify other group members (Req 8.3)
    socket.to(`group:${groupId}`).emit('member:joined', { userId });
    // Presence: broadcast online status with timestamp to the full group room
    io.to(`group:${groupId}`).emit('member:online', { userId, ts: Date.now() });
    // Emit presence snapshot for all current group members to the joining user
    io.to(`group:${groupId}`).emit('presence:update', {
      userId,
      isOnline: true,
      lastSeen: new Date().toISOString(),
    });

    // Bulk presence query handler — client sends list of userIds, gets back online status
    socket.on('presence:get', (
      data: unknown,
      callback: (result: { id: string; isOnline: boolean; lastSeen: string | null }[]) => void,
    ) => {
      if (typeof callback !== 'function') return;
      const { userIds } = (data as { userIds?: string[] }) ?? {};
      if (!Array.isArray(userIds)) { callback([]); return; }
      callback(
        userIds.slice(0, 100).map((id) => {
          const entry = presence.get(id);
          return {
            id,
            isOnline: entry?.isOnline ?? false,
            lastSeen: entry?.lastSeen.toISOString() ?? null,
          };
        }),
      );
    });

    // Handle real-time location updates (Req 8.1, 8.2)
    socket.on('location:update', (data: unknown) => {
      const now = Date.now();
      const last = lastLocUpdate.get(socket.id) ?? 0;
      if (now - last < LOC_RATE_LIMIT_MS) return;
      lastLocUpdate.set(socket.id, now);

      const parsed = locationSchema.safeParse(data);
      if (!parsed.success) return;
      handleLocationUpdate({
        groupId,
        userId,
        location: parsed.data,
        redis: fastify.redis,
        db: fastify.db,
        io,
      }).catch((err: unknown) => fastify.log.error({ err }, 'location update error'));
      // Proximity check runs alongside gap-alert logic (Req 11.7, 11.8)
      handleHazardProximity({
        userId,
        location: { lat: parsed.data.lat, lng: parsed.data.lng },
        db: fastify.db,
        redis: fastify.redis,
        io,
      }).catch((err: unknown) => fastify.log.error({ err }, 'hazard proximity error'));
      // Centroid gap alert: warn user if they drift > 5 km from the group centroid
      handleCentroidGapAlert({
        groupId,
        userId,
        location: { lat: parsed.data.lat, lng: parsed.data.lng },
        redis: fastify.redis,
        db: fastify.db,
        io,
      }).catch((err: unknown) => fastify.log.error({ err }, 'centroid gap alert error'));
    });

    // PTT start (Req 10.1–10.4)
    socket.on('ptt:start', (data: unknown) => {
      const { channelId } = (data as PttStartPayload) ?? {};
      if (!channelId) return;
      handlePttStart({
        groupId, userId, channelId,
        db: fastify.db,
        io,
      }).catch((err: unknown) => fastify.log.error({ err }, 'ptt start error'));
    });

    // PTT end (Req 10.5, 10.6)
    socket.on('ptt:end', (data: unknown) => {
      const { logId } = (data as { logId: string }) ?? {};
      if (!logId) return;
      handlePttEnd({
        groupId, userId, logId,
        db: fastify.db,
        io,
      }).catch((err: unknown) => fastify.log.error({ err }, 'ptt end error'));
    });

    // Quick-action convoy alerts (Stopping / Regrouping / Incident)
    socket.on('convoy:alert', (data: unknown) => {
      const { type, message, groupId: alertGroupId } = (data as {
        type?: 'stopping' | 'regroup' | 'incident';
        message?: string;
        groupId?: string;
      }) ?? {};
      if (!type || !message || alertGroupId !== groupId) return;

      (async () => {
        const result = await fastify.db.query<{ ptt_callsign: string | null; display_name: string }>(
          'SELECT ptt_callsign, display_name FROM users WHERE id = $1',
          [userId],
        );
        const user = result.rows[0];
        const senderCallsign = user?.ptt_callsign ?? user?.display_name ?? 'Unknown';

        io.to(`group:${groupId}`).emit('convoy:alert', {
          type,
          message,
          senderCallsign,
          senderId: userId,
          timestamp: new Date().toISOString(),
        });

        // Non-fatal: persist alert to notification_history for offline members
        try {
          const members = await fastify.db.query<{ user_id: string }>(
            'SELECT user_id FROM convoy_members WHERE group_id = $1 AND user_id != $2 AND left_at IS NULL',
            [groupId, userId],
          );
          for (const m of members.rows) {
            await fastify.db.query(
              'INSERT INTO notification_history (user_id, type, title, body, data) VALUES ($1, $2, $3, $4, $5)',
              [m.user_id, 'convoy_alert', `${senderCallsign}: ${type}`, message, JSON.stringify({ groupId })],
            );
          }
        } catch { /* non-fatal */ }
      })().catch((err: unknown) => fastify.log.error({ err }, 'convoy alert error'));
    });

    // PTT replay request — logs the intent (audio storage not yet implemented)
    socket.on('ptt:replay_request', (data: unknown) => {
      const { messageId } = (data as { messageId?: string }) ?? {};
      fastify.log.info({ messageId, groupId, userId }, 'ptt replay requested');
    });

    // Admin mute/unmute a member's PTT (Req 10.11)
    socket.on('ptt:admin_mute', (data: unknown) => {
      const { targetUserId, muted } = (data as { targetUserId?: string; muted?: boolean }) ?? {};
      if (!targetUserId || typeof muted !== 'boolean') return;

      (async () => {
        // Verify emitter is the group admin
        const adminCheck = await fastify.db.query<{ admin_id: string }>(
          'SELECT admin_id FROM convoy_groups WHERE id = $1 AND status = \'active\'',
          [groupId],
        );
        if (adminCheck.rows[0]?.admin_id !== userId) return;

        await fastify.db.query(
          `UPDATE convoy_members SET is_muted = $1
           WHERE group_id = $2 AND user_id = $3 AND left_at IS NULL`,
          [muted, groupId, targetUserId],
        );

        // Notify the target member
        const event = muted ? 'ptt:muted' : 'ptt:unmuted';
        io.to(`user:${targetUserId}`).emit(event, { groupId, mutedBy: userId, muted });
        // Also notify the group so other members see the updated state
        io.to(`group:${groupId}`).emit('member:mute_changed', { userId: targetUserId, muted });
      })().catch((err: unknown) => fastify.log.error({ err }, 'ptt admin mute error'));
    });

    // Relay typing indicator to group room (excludes sender)
    socket.on('chat:typing', (data: unknown) => {
      const { displayName } = (data as { displayName?: string }) ?? {};
      if (!displayName) return;
      socket.to(`group:${groupId}`).emit('chat:typing', { displayName });
    });

    // Persist and broadcast emoji reaction on a group message
    socket.on('chat:react', (data: unknown) => {
      const { messageId, emoji, action } =
        (data as { messageId?: string; emoji?: string; action?: string }) ?? {};
      if (!messageId || !emoji || (action !== 'add' && action !== 'remove')) return;

      (async () => {
        // Verify the message belongs to this group before touching the DB
        const msgCheck = await fastify.db.query<{ id: string }>(
          'SELECT id FROM group_messages WHERE id = $1 AND group_id = $2',
          [messageId, groupId],
        );
        if ((msgCheck.rowCount ?? 0) === 0) return;

        if (action === 'add') {
          await fastify.db.query(
            `INSERT INTO message_reactions (message_id, user_id, emoji)
             VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [messageId, userId, emoji],
          );
        } else {
          await fastify.db.query(
            `DELETE FROM message_reactions
             WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
            [messageId, userId, emoji],
          );
        }

        io.to(`group:${groupId}`).emit('group:reaction', { messageId, userId, emoji, action });
      })().catch((err: unknown) => fastify.log.error({ err }, 'chat react error'));
    });

    // hazard:vote — confirm or dismiss a hazard (up=confirm, down=dismiss)
    socket.on('hazard:vote', (data: unknown) => {
      const { hazardId, vote } = (data as { hazardId?: string; vote?: string }) ?? {};
      if (!hazardId || (vote !== 'up' && vote !== 'down')) return;
      const dbVote = vote === 'up' ? 'confirm' : 'dismiss';
      const countCol = vote === 'up' ? 'confirmation_count' : 'dismissal_count';
      const reverseCol = vote === 'up' ? 'dismissal_count' : 'confirmation_count';

      (async () => {
        // Check hazard exists and is active
        const hazard = await fastify.db.query<{ id: string; confirmation_count: number; dismissal_count: number }>(
          `SELECT id, confirmation_count, dismissal_count FROM hazard_reports WHERE id = $1 AND status = 'active'`,
          [hazardId],
        );
        if (!hazard.rows[0]) return;

        // Upsert vote (user may change their mind)
        const existing = await fastify.db.query<{ vote: string }>(
          `SELECT vote FROM hazard_votes WHERE hazard_id = $1 AND user_id = $2`,
          [hazardId, userId],
        );

        if (existing.rows[0]) {
          if (existing.rows[0].vote === dbVote) return; // same vote, no-op
          // Changed vote — decrement old, increment new
          await fastify.db.query(
            `UPDATE hazard_votes SET vote = $3 WHERE hazard_id = $1 AND user_id = $2`,
            [hazardId, userId, dbVote],
          );
          await fastify.db.query(
            `UPDATE hazard_reports
             SET ${countCol} = ${countCol} + 1, ${reverseCol} = GREATEST(${reverseCol} - 1, 0)
             WHERE id = $1`,
            [hazardId],
          );
        } else {
          await fastify.db.query(
            `INSERT INTO hazard_votes (hazard_id, user_id, vote) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [hazardId, userId, dbVote],
          );
          await fastify.db.query(
            `UPDATE hazard_reports SET ${countCol} = ${countCol} + 1 WHERE id = $1`,
            [hazardId],
          );
        }

        // Auto-dismiss when dismissal votes exceed 3
        const updated = await fastify.db.query<{ confirmation_count: number; dismissal_count: number }>(
          `SELECT confirmation_count, dismissal_count FROM hazard_reports WHERE id = $1`,
          [hazardId],
        );
        if ((updated.rows[0]?.dismissal_count ?? 0) >= 3) {
          await fastify.db.query(
            `UPDATE hazard_reports SET status = 'dismissed' WHERE id = $1`,
            [hazardId],
          );
        }

        io.to(`group:${groupId}`).emit('hazard:vote_updated', {
          hazardId,
          thumbsUp: updated.rows[0]?.confirmation_count ?? 0,
          thumbsDown: updated.rows[0]?.dismissal_count ?? 0,
        });
      })().catch((err: unknown) => fastify.log.error({ err }, 'hazard vote error'));
    });

    // convoy:member_ready — relay lobby ready-state to group
    socket.on('convoy:member_ready', (data: unknown) => {
      const { userId: readyUserId } = (data as { userId?: string }) ?? {};
      if (!readyUserId) return;
      socket.to(`group:${groupId}`).emit('convoy:member_ready', { userId: readyUserId });
    });

    // convoy:start — admin starts the convoy from lobby
    socket.on('convoy:start', async (data: unknown) => {
      const { groupId: payloadGroupId } = (data as { groupId?: string }) ?? {};
      if (!payloadGroupId) return;
      try {
        const group = await fastify.db.query<{ admin_id: string }>(
          `SELECT admin_id FROM convoy_groups WHERE id = $1`,
          [payloadGroupId],
        );
        if (group.rows[0]?.admin_id !== userId) return;
        io.to(`group:${payloadGroupId}`).emit('convoy:started', { groupId: payloadGroupId, startedBy: userId });
      } catch (err) {
        fastify.log.error({ err }, 'convoy start error');
      }
    });

    // sos:acknowledge — relay SOS acknowledgment to group
    socket.on('sos:acknowledge', (data: unknown) => {
      const { sosId, memberName } = (data as { sosId?: string; memberName?: string }) ?? {};
      if (!sosId) return;
      socket.to(`group:${groupId}`).emit('sos:acknowledged', { sosId, memberName, acknowledgedBy: userId });
    });

    // waypoint:reached — relay waypoint arrival notification to group
    socket.on('waypoint:reached', (data: unknown) => {
      const { waypointId, type, message } =
        (data as { waypointId?: string; type?: string; message?: string }) ?? {};
      if (!waypointId) return;
      socket.to(`group:${groupId}`).emit('waypoint:reached', { waypointId, type, message, userId });
    });

    // Notify group on disconnect and clean up Redis presence (Req 8.3)
    socket.on('disconnect', () => {
      lastLocUpdate.delete(socket.id);
      // Only mark offline if this is the user's current socket (guard against multi-tab)
      const entry = presence.get(userId);
      if (entry?.socketId === socket.id) {
        presence.set(userId, { isOnline: false, lastSeen: new Date(), socketId: socket.id });
        io.to(`group:${groupId}`).emit('presence:update', {
          userId,
          isOnline: false,
          lastSeen: new Date().toISOString(),
        });
      }
      io.to(`group:${groupId}`).emit('member:left', { userId });
      io.to(`group:${groupId}`).emit('member:offline', { userId, ts: Date.now() });
      fastify.redis.del(`loc:${groupId}:${userId}`).catch((err: unknown) => fastify.log.error({ err }, 'redis del error'));
    });
  };
}
