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

  // 1. Write to Redis with 10-second sliding-window TTL (Req 8.2)
  await redis.hset(locKey, {
    lat: String(location.lat),
    lng: String(location.lng),
    heading: String(location.heading),
    speed_kph: String(location.speed_kph),
    ts: String(location.ts),
  });
  await redis.expire(locKey, 10);

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

  // Get the log row to find channel and validate duration
  const logResult = await db.query<{
    id: string; channel_id: string | null; started_at: Date;
  }>(
    'SELECT id, channel_id, started_at FROM ptt_log WHERE id = $1 AND user_id = $2',
    [logId, userId],
  );
  const log = logResult.rows[0];
  if (!log) return;

  const groupResult = await db.query<{ ptt_max_seconds: number }>(
    'SELECT ptt_max_seconds FROM convoy_groups WHERE id = $1',
    [groupId],
  );
  const maxSeconds = groupResult.rows[0]?.ptt_max_seconds ?? 30;

  const exceeded = isDurationExceeded(log.started_at.getTime(), now, maxSeconds);

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

  const payload = { logId, userId, groupId, durationExceeded: exceeded };
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
    const alreadyAlerted = await redis.sismember(alertedKey, hazard.id);
    if (alreadyAlerted) continue;

    io.to(`user:${userId}`).emit('hazard:nearby', {
      id: hazard.id,
      type: hazard.hazard_type,
      lat: hazard.lat,
      lng: hazard.lng,
    });

    await redis.sadd(alertedKey, hazard.id);
    await redis.expire(alertedKey, 3600);
  }
}

// ---------------------------------------------------------------------------
// Socket.io connection handler factory
// ---------------------------------------------------------------------------
export function registerSocketHandlers(
  fastify: FastifyInstance,
  io: SocketIO,
): (socket: Socket) => void {
  return (socket: Socket) => {
    const userId = socket.data.userId as string;
    const groupId = socket.data.groupId as string;

    if (!groupId) {
      socket.disconnect(true);
      return;
    }

    // Join group room and personal room
    void socket.join(`group:${groupId}`);
    void socket.join(`user:${userId}`);

    // Notify other group members (Req 8.3)
    socket.to(`group:${groupId}`).emit('member:joined', { userId });

    // Handle real-time location updates (Req 8.1, 8.2)
    socket.on('location:update', (data: unknown) => {
      const parsed = locationSchema.safeParse(data);
      if (!parsed.success) return;
      void handleLocationUpdate({
        groupId,
        userId,
        location: parsed.data,
        redis: fastify.redis,
        db: fastify.db,
        io,
      });
      // Proximity check runs alongside gap-alert logic (Req 11.7, 11.8)
      void handleHazardProximity({
        userId,
        location: { lat: parsed.data.lat, lng: parsed.data.lng },
        db: fastify.db,
        redis: fastify.redis,
        io,
      });
    });

    // PTT start (Req 10.1–10.4)
    socket.on('ptt:start', (data: unknown) => {
      const { channelId } = (data as PttStartPayload) ?? {};
      if (!channelId) return;
      void handlePttStart({
        groupId, userId, channelId,
        db: fastify.db,
        io,
      });
    });

    // PTT end (Req 10.5, 10.6)
    socket.on('ptt:end', (data: unknown) => {
      const { logId } = (data as { logId: string }) ?? {};
      if (!logId) return;
      void handlePttEnd({
        groupId, userId, logId,
        db: fastify.db,
        io,
      });
    });

    // Notify group on disconnect (Req 8.3)
    socket.on('disconnect', () => {
      io.to(`group:${groupId}`).emit('member:left', { userId });
    });
  };
}
