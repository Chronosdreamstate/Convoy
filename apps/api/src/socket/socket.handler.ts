import { FastifyInstance } from 'fastify';
import { Server as SocketIO, Socket } from 'socket.io';
import { z } from 'zod';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { canTransmit, isDurationExceeded } from '../ptt/ptt.routes';
import { computeExpiresAt } from '../hazards/hazards.routes';
import { incrementStatCounter } from '../db/statCounters';
import { haversineMeters, LatLng } from '../utils/geo';

// Re-exported so existing consumers (property/integration tests) that import
// these from socket.handler keep working after the move to utils/geo.
export { haversineMeters };
export type { LatLng };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

export const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  heading: z.number().min(0).max(360),
  speed_kph: z.number().min(0),
  ts: z.number().int().positive(),
});

const STALE_THRESHOLD_MS = 30_000; // 30 seconds (Property 40)

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
  /** Optional — pushes background notifications alongside the in-app socket events (Req 15.1, 15.3, 24.1–24.6). */
  enqueueNotification?: (job: {
    userId: string;
    type: 'gap_alert' | 'arriving_destination';
    title: string;
    body: string;
    data?: Record<string, string>;
  }) => Promise<void>;
}): Promise<void> {
  const { groupId, userId, location, redis, db, io, now = Date.now(), enqueueNotification } = params;
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

  // 3. Bump last_activity_at (Req 38.1 — join code expires after 24h of group
  // inactivity; a location update is the most frequent activity signal a
  // live session produces) and fetch data needed for gap alert computation
  // — non-admin members only (Req 24.1–24.6) — in the same round-trip.
  const groupResult = await db.query<{ admin_id: string; gap_threshold_m: number }>(
    `UPDATE convoy_groups SET last_activity_at = now()
     WHERE id = $1 AND status = 'active'
     RETURNING admin_id, gap_threshold_m`,
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
    const distanceM = Math.round(distance);

    // Fetch the lagging member's callsign/name — NotificationCenterScreen's gap:alert
    // handler renders `${d.callsign ?? 'Someone'} fell behind`, but this field was
    // never included, so the notification always showed the generic fallback text.
    const memberInfoResult = await db.query<{ display_name: string; ptt_callsign: string | null }>(
      'SELECT display_name, ptt_callsign FROM users WHERE id = $1',
      [userId],
    );
    const memberInfo = memberInfoResult.rows[0];
    const callsign = memberInfo?.ptt_callsign ?? memberInfo?.display_name ?? undefined;

    // Emit gap:alert to admin's personal room only (Property 39)
    io.to(`user:${group.admin_id}`).emit('gap:alert', {
      memberId: userId,
      distanceM,
      groupId,
      callsign,
    });

    // Also push a background notification so a backgrounded/killed admin app
    // still surfaces the gap (Req 15.1 pattern, Req 24.1–24.6).
    if (enqueueNotification) {
      await enqueueNotification({
        userId: group.admin_id,
        type: 'gap_alert',
        title: 'Member Falling Behind',
        body: `A member is ${distanceM}m behind the group`,
        data: { groupId, memberId: userId, distanceM: String(distanceM) },
      }).catch(() => { /* non-fatal — in-app alert already delivered */ });
    }
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

        // Also push a background notification (Req 15.3) so a backgrounded/killed
        // app still tells the member they've arrived.
        if (enqueueNotification) {
          await enqueueNotification({
            userId,
            type: 'arriving_destination',
            title: 'Arrived',
            body: "You've arrived at the destination",
            data: { groupId },
          }).catch(() => { /* non-fatal — in-app event already delivered */ });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Groupless friend-level location sharing — exported for unit testing
//
// A user with no active convoy can still opt in (user_settings.
// share_location_with_friends) to share their live location with their
// accepted friends. This is intentionally independent of handleLocationUpdate
// above: no group room to broadcast to, no gap-alert/distance-counter/arrival
// logic applies, and it must work with zero group membership at all. The
// cached fix is picked up by polling GET /api/v1/friends/locations rather
// than pushed live, so this is just a cache write (short TTL, mirrors the
// existing loc:<groupId>:<userId> 35s pattern) gated on the DB flag.
// ---------------------------------------------------------------------------
export const FRIEND_LOC_TTL_SECONDS = 35;

export async function handleFriendLocationUpdate(params: {
  userId: string;
  location: LocationPayload;
  redis: Redis;
  db: Pool;
}): Promise<void> {
  const { userId, location, redis, db } = params;

  const settingsResult = await db.query<{ share_location_with_friends: boolean }>(
    `SELECT share_location_with_friends FROM user_settings WHERE user_id = $1`,
    [userId],
  );

  // Hard gate: never cache a location update unless the user has explicitly
  // opted in. No row at all (settings never initialized) defaults to "off".
  if (!settingsResult.rows[0]?.share_location_with_friends) return;

  const locKey = `loc:friend:${userId}`;
  await redis.hset(locKey, {
    lat: String(location.lat),
    lng: String(location.lng),
    heading: String(location.heading),
    speed_kph: String(location.speed_kph),
    ts: String(location.ts),
  });
  await redis.expire(locKey, FRIEND_LOC_TTL_SECONDS);
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
  const channelResult = await db.query<{ id: string; is_all: boolean; name: string | null }>(
    'SELECT id, is_all, name FROM ptt_channels WHERE id = $1 AND group_id = $2',
    [channelId, groupId],
  );
  const channel = channelResult.rows[0];
  if (!channel) return { logId: null };

  // Sub-channel transmissions require assignment to that channel (Req 26.4) —
  // mirrors the /ptt/token gate. Without this, any group member could emit
  // ptt:start with a sub-channel id they were never added to and spoof log
  // entries / LIVE indicators into that channel (their audio is already
  // blocked by the token check, making the phantom entry doubly misleading).
  // The "All" channel is exempt: every active member can always reach it (Req 26.5).
  if (!channel.is_all) {
    const channelMember = await db.query(
      'SELECT 1 FROM ptt_channel_members WHERE channel_id = $1 AND user_id = $2',
      [channelId, userId],
    );
    if ((channelMember.rowCount ?? 0) === 0) return { logId: null };
  }

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

  // Fetch sender's callsign/name and active vehicle type — PTTLogPanel renders
  // `entry.callsign ?? entry.displayName` where displayName was previously being
  // seeded from the raw userId (these fields were never sent), so every log entry
  // showed a UUID instead of the transmitting member's name (Req 10.9, 39.2).
  const senderResult = await db.query<{ display_name: string; ptt_callsign: string | null }>(
    'SELECT display_name, ptt_callsign FROM users WHERE id = $1',
    [userId],
  );
  const sender = senderResult.rows[0];
  const callsign = sender?.ptt_callsign ?? sender?.display_name ?? undefined;

  const vehicleResult = await db.query<{ vehicle_type: string | null }>(
    'SELECT vehicle_type FROM vehicles WHERE user_id = $1 AND is_active = true LIMIT 1',
    [userId],
  );
  const vehicleType = vehicleResult.rows[0]?.vehicle_type ?? undefined;

  // Broadcast ptt:transmit to all recipients via their personal rooms (Properties 43 & 44).
  // channelName lets PTTLogPanel label entries with the human-readable channel
  // name instead of the raw channel UUID (Req 27.2).
  const payload = { logId, userId, channelId, groupId, callsign, vehicleType, channelName: channel.name ?? undefined };
  for (const recipientId of recipientIds) {
    io.to(`user:${recipientId}`).emit('ptt:transmit', payload);
  }

  return { logId };
}

/**
 * Handles ptt:end: validates duration, broadcasts ptt:ended.
 *
 * `logId` is optional: the client only learns its own logId from the server's
 * `ptt:transmit` echo, so a very quick tap-and-release can call holdEnd()
 * before that echo arrives (Req 10.3). When logId is omitted, fall back to
 * the member's most recent still-open transmission in this group so the
 * ptt_log row is still closed out and ptt:ended still fires (Req 10.9, 27.1).
 */
export async function handlePttEnd(params: {
  groupId: string;
  userId: string;
  logId?: string;
  db: Pool;
  io: IoBroadcaster;
  now?: number;
}): Promise<void> {
  const { groupId, userId, db, io, now = Date.now() } = params;

  // Get the log row to find channel and validate duration — include group_id to prevent cross-group manipulation
  const logResult = params.logId
    ? await db.query<{ id: string; channel_id: string | null; started_at: Date }>(
        'SELECT id, channel_id, started_at FROM ptt_log WHERE id = $1 AND user_id = $2 AND group_id = $3',
        [params.logId, userId, groupId],
      )
    : await db.query<{ id: string; channel_id: string | null; started_at: Date }>(
        // Bounded to the last 2 minutes (well above the 60s max PTT duration, Req 10.6)
        // so a long-abandoned open row from a crashed/killed client is never mistaken
        // for the transmission that just ended.
        `SELECT id, channel_id, started_at FROM ptt_log
         WHERE user_id = $1 AND group_id = $2 AND ended_at IS NULL
           AND started_at > NOW() - INTERVAL '2 minutes'
         ORDER BY started_at DESC LIMIT 1`,
        [userId, groupId],
      );
  const log = logResult.rows[0];
  if (!log) return;
  const logId = log.id;

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
    const channelRow = channelResult.rows[0];
    // No row means the channel was deleted mid-transmission — fall back to the
    // whole group so ptt:ended still reaches everyone who received
    // ptt:transmit and media ducking is never left stuck on (Req 10.9).
    // (Previously a deleted channel resolved to an empty ptt_channel_members
    // list and the end event went to nobody.)
    const isAll = channelRow?.is_all ?? true;
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
// SOS acknowledgment — exported for property testing
//
// Routing is driven by the SOS pin itself (stored in Redis by rally.routes.ts
// for the pin's 2h lifetime), NOT by the acknowledging socket's convoy:
//   - group SOS      → broadcast to that group's room (owner included);
//   - standalone SOS → emit to the owner's personal room. Previously the relay
//     targeted `group:<ackers groupId>`, which for a groupless acknowledger was
//     the bogus room `group:` — the friend who raised a standalone SOS never
//     learned anyone had seen it (Req 25.5/25.7).
// When the pin has already expired from Redis, fall back to the acknowledger's
// own group room (the pre-fix behavior) so an in-convoy ack still relays.
// ---------------------------------------------------------------------------
export async function handleSosAcknowledge(params: {
  sosId: string;
  memberName?: string;
  ackUserId: string;
  /** The acknowledging socket's resolved groupId ('' when not in a convoy). */
  groupId: string;
  redis: Redis;
  db: Pool;
  io: IoBroadcaster;
}): Promise<void> {
  const { sosId, memberName, ackUserId, groupId, redis, db, io } = params;
  const payload = { sosId, memberName, acknowledgedBy: ackUserId };

  let sos: { userId?: string; groupId?: string | null } | null = null;
  try {
    const raw = await redis.get(`sos:${sosId}`);
    if (raw) sos = JSON.parse(raw) as { userId?: string; groupId?: string | null };
  } catch { /* fall through to the acknowledger's group room below */ }

  if (sos?.groupId) {
    io.to(`group:${sos.groupId}`).emit('sos:acknowledged', payload);
  } else if (sos?.userId) {
    io.to(`user:${sos.userId}`).emit('sos:acknowledged', payload);
  } else if (groupId) {
    io.to(`group:${groupId}`).emit('sos:acknowledged', payload);
  }

  // sos_hero achievement — credit the member who responded to the alert.
  await incrementStatCounter(db, ackUserId, 'sos_hero', 1);
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
  /** Optional — pushes a background notification alongside the in-app banner (Req 15.1). */
  enqueueNotification?: (job: {
    userId: string;
    type: 'hazard_alert';
    title: string;
    body: string;
    data?: Record<string, string>;
  }) => Promise<void>;
}): Promise<void> {
  const { userId, location, db, redis, io, enqueueNotification } = params;

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

    // Req 15.1: deliver BOTH a push notification and the in-app banner (above).
    if (enqueueNotification) {
      const label = hazard.hazard_type.replace(/_/g, ' ');
      await enqueueNotification({
        userId,
        type: 'hazard_alert',
        title: 'Hazard Ahead',
        body: `${label.charAt(0).toUpperCase()}${label.slice(1)} reported nearby`,
        data: { hazardId: hazard.id, hazardType: hazard.hazard_type, lat: String(hazard.lat), lng: String(hazard.lng) },
      }).catch(() => { /* non-fatal — in-app banner already delivered */ });
    }
  }
}

// ---------------------------------------------------------------------------
// Presence store (Redis-backed, cluster-wide)
//
// Presence used to live in an in-memory per-process Map, but socket.io runs
// with the Redis adapter for horizontal scaling — with more than one node a
// `presence:get` answered by node A knew nothing about sockets on node B, so
// presence answers were simply wrong cluster-wide. Presence now lives in
// Redis:
//
//   presence:online:<userId>   -> owning socketId, TTL-refreshed heartbeat.
//     Existence of the key == "online". The TTL (rather than relying solely
//     on disconnect events) also self-heals when a node dies without firing
//     disconnects. Refreshed by the engine.io pong the client sends every
//     pingInterval (25s by default) and by the app-level 'ping' heartbeat
//     WebSocketService emits.
//   presence:lastseen:<userId> -> ISO timestamp, 24h TTL.
//     The TTL replaces the old prunePresence() sweep: entries for users not
//     seen in 24h simply expire.
//
// The client-facing API shape ({ id, isOnline, lastSeen }[] via presence:get,
// and presence:update events) is unchanged.
// ---------------------------------------------------------------------------

export const PRESENCE_ONLINE_TTL_SECONDS = 90; // ~3 missed 25s heartbeats
export const PRESENCE_LASTSEEN_TTL_SECONDS = 24 * 60 * 60;

const presenceOnlineKey = (userId: string) => `presence:online:${userId}`;
const presenceLastSeenKey = (userId: string) => `presence:lastseen:${userId}`;

/** Mark a user online, owned by the given socket. Exported for property tests. */
export async function setPresenceOnline(
  redis: Redis,
  userId: string,
  socketId: string,
  now: number = Date.now(),
): Promise<void> {
  await redis.set(presenceOnlineKey(userId), socketId, 'EX', PRESENCE_ONLINE_TTL_SECONDS);
  await redis.set(
    presenceLastSeenKey(userId),
    new Date(now).toISOString(),
    'EX',
    PRESENCE_LASTSEEN_TTL_SECONDS,
  );
}

/**
 * Heartbeat: re-arm the online TTL — but only when this socket still owns the
 * user's presence (a newer connection from another device/tab takes ownership
 * and must not be clobbered by a stale socket's heartbeat). An expired key
 * (owner === null) is re-established: the socket is demonstrably still alive.
 */
export async function refreshPresence(
  redis: Redis,
  userId: string,
  socketId: string,
  now: number = Date.now(),
): Promise<void> {
  const owner = await redis.get(presenceOnlineKey(userId));
  if (owner !== null && owner !== socketId) return;
  await setPresenceOnline(redis, userId, socketId, now);
}

/**
 * Mark a user offline on disconnect. Returns true only when the presence
 * actually transitioned (i.e. this socket owned it) — the multi-tab guard:
 * if the user reconnected (new socket owns the key), the old socket's
 * disconnect must not flip them offline.
 */
export async function setPresenceOffline(
  redis: Redis,
  userId: string,
  socketId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const owner = await redis.get(presenceOnlineKey(userId));
  if (owner !== socketId) return false;
  await redis.del(presenceOnlineKey(userId));
  await redis.set(
    presenceLastSeenKey(userId),
    new Date(now).toISOString(),
    'EX',
    PRESENCE_LASTSEEN_TTL_SECONDS,
  );
  return true;
}

/** Bulk presence lookup backing the `presence:get` socket query. */
export async function getPresence(
  redis: Redis,
  userIds: string[],
): Promise<{ id: string; isOnline: boolean; lastSeen: string | null }[]> {
  const ids = userIds.slice(0, 100);
  if (ids.length === 0) return [];
  const online = await redis.mget(...ids.map(presenceOnlineKey));
  const lastSeen = await redis.mget(...ids.map(presenceLastSeenKey));
  return ids.map((id, i) => ({
    id,
    isOnline: online[i] !== null && online[i] !== undefined,
    lastSeen: lastSeen[i] ?? null,
  }));
}

// ---------------------------------------------------------------------------
// DM room membership — a user's DM channels are joined as socket rooms on
// connect so `group:message` / `group:reaction` broadcasts (groups/
// chat.routes.ts emits to `group:<id>`) reach DM participants live even when
// neither user is in a convoy. Exported for property tests.
// ---------------------------------------------------------------------------
export async function getUserDmGroupIds(db: Pool, userId: string): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `SELECT g.id FROM convoy_groups g
     JOIN convoy_members m ON m.group_id = g.id
     WHERE g.type = 'dm' AND m.user_id = $1 AND m.left_at IS NULL`,
    [userId],
  );
  return result.rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Socket.io connection handler factory
// ---------------------------------------------------------------------------
export function registerSocketHandlers(
  fastify: FastifyInstance,
  io: SocketIO,
): (socket: Socket) => void {
  const lastLocUpdate = new Map<string, number>();
  const LOC_RATE_LIMIT_MS = 500; // max 2 location updates per second per socket

  return (socket: Socket) => {
    const userId = socket.data.userId as string;
    let groupId = socket.data.groupId as string;

    if (!userId) {
      socket.disconnect(true);
      return;
    }

    // ── Connect-time async setup, captured as a `ready` promise ────────────
    //
    // Everything that needs a DB/Redis round-trip on connect (active-group
    // lookup, membership check, presence write, room joins, join broadcasts)
    // runs inside this promise. Event listeners are registered SYNCHRONOUSLY
    // below — previously they were registered only after these awaits, so a
    // client emitting immediately after 'connect' raced the setup and could
    // lose the event (and its ack) entirely. Listeners that depend on the
    // setup's results (the resolved groupId, joined rooms, membership
    // authorization) await `ready` internally via whenReady() instead of
    // dropping early events.
    //
    // setupOk stays false when the socket never became authorized (membership
    // check failed / setup crashed) — whenReady() then returns false and every
    // gated listener drops the event, matching the old behavior where no
    // listeners existed at all on such sockets.
    let setupOk = false;
    const ready: Promise<void> = (async () => {
      // Auto-rejoin on reconnect: if groupId is absent from auth (e.g. client reconnected
      // with only a JWT), look up the user's current active group membership in the DB.
      // A user with no active convoy at all (e.g. IdleMapScreen, the groupless/friend-SOS
      // case) is still a valid connection — they just don't get a group room. They still
      // need their personal `user:<id>` room joined below so standalone events like a
      // friend's SOS (`POST /sos` → `sos:alert`) reach them live.
      if (!groupId) {
        const activeGroup = await fastify.db.query<{ group_id: string }>(
          `SELECT group_id FROM convoy_members WHERE user_id = $1 AND left_at IS NULL LIMIT 1`,
          [userId],
        );
        groupId = activeGroup.rows[0]?.group_id ?? '';
      }

      if (groupId) {
        // Verify active membership before joining room — prevents unauthorized room access
        const memberCheck = await fastify.db.query<{ id: string }>(
          `SELECT id FROM convoy_members WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL`,
          [groupId, userId],
        );
        if (memberCheck.rows.length === 0) {
          socket.disconnect(true);
          return;
        }
      }

      // Client vanished during the DB round-trips above — don't write presence
      // or join rooms for a dead socket.
      if (!socket.connected) return;

      // Track presence in Redis (cluster-wide; TTL-based heartbeat below)
      await setPresenceOnline(fastify.redis, userId, socket.id).catch((err: unknown) =>
        fastify.log.error({ err }, 'presence online error'),
      );

      // Personal room — joined unconditionally (even with no active group) so
      // standalone/direct events (friend SOS, PTT DMs, gap alerts, etc.) always reach
      // this socket.
      await socket.join(`user:${userId}`);

      // DM channel rooms — joined unconditionally so DM messages/reactions
      // (broadcast to `group:<dmId>` by groups/chat.routes.ts) arrive live even
      // with no active convoy. Channels created mid-session are covered by
      // POST /dm's socketsJoin and by the dm:join handler below.
      try {
        const dmGroupIds = await getUserDmGroupIds(fastify.db, userId);
        for (const dmGroupId of dmGroupIds) {
          await socket.join(`group:${dmGroupId}`);
        }
      } catch (err: unknown) {
        fastify.log.error({ err }, 'dm room join error');
      }

      if (groupId) {
        // Join group room — must be awaited before broadcasting
        await socket.join(`group:${groupId}`);

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
      }

      setupOk = true;
    })().catch((err: unknown) => {
      fastify.log.error({ err }, 'socket connection setup error');
      socket.disconnect(true);
    });

    /**
     * Awaits the connect-time setup. Resolves true once the socket is fully
     * set up (rooms joined, groupId resolved); false when the socket never
     * became authorized — gated listeners must then drop the event. Never
     * rejects (`ready` swallows its own errors above).
     */
    const whenReady = async (): Promise<boolean> => {
      await ready;
      return setupOk;
    };

    // ── Event listeners — registered synchronously so first emits are never
    //    lost; anything depending on the async setup awaits whenReady() ─────

    // Keep the online TTL armed. The engine.io layer receives a pong from the
    // client every pingInterval (25s default) regardless of app traffic —
    // hook it as the heartbeat so presence survives idle-but-connected
    // sockets and self-expires when a node dies without disconnect events.
    (socket.conn as unknown as { on(ev: string, cb: (p: { type?: string }) => void): void }).on(
      'packet',
      (packet) => {
        if (packet?.type !== 'pong') return;
        whenReady()
          .then((ok) => (ok ? refreshPresence(fastify.redis, userId, socket.id) : undefined))
          .catch((err: unknown) => fastify.log.error({ err }, 'presence refresh error'));
      },
    );
    // Belt-and-braces: WebSocketService also emits an app-level 'ping' every
    // 25s while foregrounded — refresh on that too.
    socket.on('ping', () => {
      whenReady()
        .then((ok) => (ok ? refreshPresence(fastify.redis, userId, socket.id) : undefined))
        .catch((err: unknown) => fastify.log.error({ err }, 'presence refresh error'));
    });

    // Bulk presence query handler — client sends list of userIds, gets back online status
    socket.on('presence:get', (
      data: unknown,
      callback: (result: { id: string; isOnline: boolean; lastSeen: string | null }[]) => void,
    ) => {
      if (typeof callback !== 'function') return;
      const { userIds } = (data as { userIds?: string[] }) ?? {};
      if (!Array.isArray(userIds) || !userIds.every((id) => typeof id === 'string')) {
        callback([]);
        return;
      }
      whenReady()
        .then((ok) => {
          // Never-authorized socket: no ack — it is being disconnected.
          if (!ok) return;
          return getPresence(fastify.redis, userIds).then(callback);
        })
        .catch((err: unknown) => {
          fastify.log.error({ err }, 'presence get error');
          callback([]);
        });
    });

    // dm:join — explicitly join a DM channel room. Covers channels that came
    // into existence after this socket connected (connect-time DM room join
    // above only sees channels that already existed) — e.g. the other side
    // opened a brand-new DM thread with us mid-session. Membership-checked:
    // only an active member of a type='dm' group may join its room.
    socket.on('dm:join', (data: unknown, callback?: (result: { ok: boolean }) => void) => {
      const cb = typeof callback === 'function' ? callback : undefined;
      const { groupId: dmGroupId } = (data as { groupId?: string }) ?? {};
      if (!dmGroupId || typeof dmGroupId !== 'string') { cb?.({ ok: false }); return; }
      (async () => {
        if (!(await whenReady())) { cb?.({ ok: false }); return; }
        const check = await fastify.db.query(
          `SELECT 1 FROM convoy_members m
           JOIN convoy_groups g ON g.id = m.group_id
           WHERE g.id = $1 AND g.type = 'dm' AND m.user_id = $2 AND m.left_at IS NULL`,
          [dmGroupId, userId],
        );
        if ((check.rowCount ?? 0) === 0) { cb?.({ ok: false }); return; }
        await socket.join(`group:${dmGroupId}`);
        cb?.({ ok: true });
      })().catch((err: unknown) => {
        fastify.log.error({ err }, 'dm join error');
        cb?.({ ok: false });
      });
    });

    // Handle real-time location updates (Req 8.1, 8.2)
    socket.on('location:update', (data: unknown) => {
      const now = Date.now();
      const last = lastLocUpdate.get(socket.id) ?? 0;
      if (now - last < LOC_RATE_LIMIT_MS) return;
      lastLocUpdate.set(socket.id, now);

      const parsed = locationSchema.safeParse(data);
      if (!parsed.success) return;
      // Gate on connect-time setup so an update emitted immediately after
      // 'connect' (before the active-group lookup resolved groupId) lands in
      // the right branch instead of being dropped or mis-routed as groupless.
      void whenReady().then((ok) => {
        if (!ok) return;
        if (groupId) {
          handleLocationUpdate({
            groupId,
            userId,
            location: parsed.data,
            redis: fastify.redis,
            db: fastify.db,
            io,
            enqueueNotification: fastify.enqueueNotification,
          }).catch((err: unknown) => fastify.log.error({ err }, 'location update error'));
        } else {
          // Groupless connection (e.g. IdleMapScreen) — no convoy to broadcast
          // to, so just cache for GET /friends/locations if the user has opted
          // into friend-level location sharing.
          handleFriendLocationUpdate({
            userId,
            location: parsed.data,
            redis: fastify.redis,
            db: fastify.db,
          }).catch((err: unknown) => fastify.log.error({ err }, 'friend location update error'));
        }
        // Proximity check runs alongside gap-alert logic (Req 11.7, 11.8, 15.1)
        handleHazardProximity({
          userId,
          location: { lat: parsed.data.lat, lng: parsed.data.lng },
          db: fastify.db,
          redis: fastify.redis,
          io,
          enqueueNotification: fastify.enqueueNotification,
        }).catch((err: unknown) => fastify.log.error({ err }, 'hazard proximity error'));
      });
    });

    // PTT start (Req 10.1–10.4)
    socket.on('ptt:start', (data: unknown) => {
      const { channelId } = (data as PttStartPayload) ?? {};
      if (!channelId) return;
      void whenReady().then((ok) => {
        if (!ok) return;
        handlePttStart({
          groupId, userId, channelId,
          db: fastify.db,
          io,
        }).catch((err: unknown) => fastify.log.error({ err }, 'ptt start error'));
      });
    });

    // PTT end (Req 10.5, 10.6). logId may be absent on a fast tap-and-release
    // (client hasn't received the ptt:transmit echo yet) — handlePttEnd falls
    // back to the member's most recent open transmission in this case.
    socket.on('ptt:end', (data: unknown) => {
      const { logId } = (data as { logId?: string }) ?? {};
      void whenReady().then((ok) => {
        if (!ok) return;
        handlePttEnd({
          groupId, userId, logId,
          db: fastify.db,
          io,
        }).catch((err: unknown) => fastify.log.error({ err }, 'ptt end error'));
      });
    });

    // Quick-action convoy alerts (Stopping / Regrouping / Incident)
    socket.on('convoy:alert', (data: unknown) => {
      const { type, message, groupId: alertGroupId } = (data as {
        type?: 'stopping' | 'regroup' | 'incident';
        message?: string;
        groupId?: string;
      }) ?? {};
      if (!type || !message) return;

      (async () => {
        // The alertGroupId check needs the resolved groupId — gate on setup.
        if (!(await whenReady())) return;
        if (alertGroupId !== groupId) return;
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
      void whenReady().then((ok) => {
        if (!ok) return;
        fastify.log.info({ messageId, groupId, userId }, 'ptt replay requested');
      });
    });

    // Admin mute/unmute a member's PTT (Req 10.11)
    socket.on('ptt:admin_mute', (data: unknown) => {
      const { targetUserId, muted } = (data as { targetUserId?: string; muted?: boolean }) ?? {};
      if (!targetUserId || typeof muted !== 'boolean') return;

      (async () => {
        if (!(await whenReady())) return;
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

    // Relay typing indicator (excludes sender).
    //
    // The payload may carry a target groupId (GroupChatScreen always sends
    // one): when present it must name a room this socket is actually in
    // (its convoy room or one of its DM rooms joined above) — this both
    // authorizes the relay and lets DM threads show typing indicators.
    // Without a payload groupId, fall back to the socket's convoy room.
    socket.on('chat:typing', (data: unknown) => {
      const { displayName, groupId: targetGroupId } =
        (data as { displayName?: string; groupId?: string }) ?? {};
      if (!displayName) return;
      // Room membership (socket.rooms) and the convoy-room fallback (groupId)
      // are both produced by the connect-time setup — gate on it.
      void whenReady().then((ok) => {
        if (!ok) return;
        let room: string | null = null;
        if (targetGroupId && typeof targetGroupId === 'string') {
          if (!socket.rooms.has(`group:${targetGroupId}`)) return; // not a member of that thread
          room = `group:${targetGroupId}`;
        } else if (groupId) {
          room = `group:${groupId}`;
        }
        if (!room) return;
        // Include userId so recipients can filter out their own echo, and the
        // thread's groupId so recipients can attribute the event to the right
        // conversation (GroupChatScreen drops events for other threads).
        socket.to(room).emit('chat:typing', {
          userId,
          displayName,
          groupId: room.slice('group:'.length),
        });
      });
    });

    // DEPRECATED — 'chat:react' (persist + broadcast emoji reaction) was
    // removed. The mobile client reacts via the REST endpoints
    // POST/DELETE /groups/:id/messages/:messageId/react (groups/
    // chat.routes.ts), which persist and broadcast `group:reaction`
    // server-side and work for DM threads too. No shipped client emits
    // 'chat:react' anymore (verified: no emit sites in apps/mobile); any
    // stale client emitting it is simply ignored by socket.io.

    // hazard:vote — confirm or dismiss a hazard (up=confirm, down=dismiss)
    socket.on('hazard:vote', (data: unknown) => {
      const { hazardId, vote } = (data as { hazardId?: string; vote?: string }) ?? {};
      if (!hazardId || (vote !== 'up' && vote !== 'down')) return;
      const dbVote = vote === 'up' ? 'confirm' : 'dismiss';
      const countCol = vote === 'up' ? 'confirmation_count' : 'dismissal_count';
      const reverseCol = vote === 'up' ? 'dismissal_count' : 'confirmation_count';

      (async () => {
        if (!(await whenReady())) return;
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

        // Confirming resets the expiry timer to 30 minutes from now (Req 11.5).
        // This handler is the live app's actual vote path (MapScreen emits
        // 'hazard:vote', not the REST /confirm endpoint), so without this the
        // expiry reset described in Req 11.5 never happens in production.
        const expiresAt = computeExpiresAt(Date.now());

        if (existing.rows[0]) {
          if (existing.rows[0].vote === dbVote) return; // same vote, no-op
          // Changed vote — decrement old, increment new
          await fastify.db.query(
            `UPDATE hazard_votes SET vote = $3 WHERE hazard_id = $1 AND user_id = $2`,
            [hazardId, userId, dbVote],
          );
          if (vote === 'up') {
            await fastify.db.query(
              `UPDATE hazard_reports
               SET ${countCol} = ${countCol} + 1, ${reverseCol} = GREATEST(${reverseCol} - 1, 0),
                   expires_at = $2, updated_at = now()
               WHERE id = $1`,
              [hazardId, expiresAt],
            );
          } else {
            await fastify.db.query(
              `UPDATE hazard_reports
               SET ${countCol} = ${countCol} + 1, ${reverseCol} = GREATEST(${reverseCol} - 1, 0),
                   updated_at = now()
               WHERE id = $1`,
              [hazardId],
            );
          }
        } else {
          await fastify.db.query(
            `INSERT INTO hazard_votes (hazard_id, user_id, vote) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [hazardId, userId, dbVote],
          );
          if (vote === 'up') {
            await fastify.db.query(
              `UPDATE hazard_reports SET ${countCol} = ${countCol} + 1, expires_at = $2, updated_at = now() WHERE id = $1`,
              [hazardId, expiresAt],
            );
          } else {
            await fastify.db.query(
              `UPDATE hazard_reports SET ${countCol} = ${countCol} + 1, updated_at = now() WHERE id = $1`,
              [hazardId],
            );
          }
        }

        // Auto-dismiss when dismissal votes exceed 3 (Req 11.6)
        const updated = await fastify.db.query<{ confirmation_count: number; dismissal_count: number }>(
          `SELECT confirmation_count, dismissal_count FROM hazard_reports WHERE id = $1`,
          [hazardId],
        );
        if ((updated.rows[0]?.dismissal_count ?? 0) >= 3) {
          await fastify.db.query(
            `UPDATE hazard_reports SET status = 'dismissed', expires_at = now(), updated_at = now() WHERE id = $1`,
            [hazardId],
          );
          io.to(`group:${groupId}`).emit('hazard:expired', { id: hazardId });
        }

        io.to(`group:${groupId}`).emit('hazard:vote_updated', {
          hazardId,
          thumbsUp: updated.rows[0]?.confirmation_count ?? 0,
          thumbsDown: updated.rows[0]?.dismissal_count ?? 0,
        });
      })().catch((err: unknown) => fastify.log.error({ err }, 'hazard vote error'));
    });

    // convoy:member_ready — relay lobby ready-state to group.
    // The authenticated socket identity is used, NOT the payload — otherwise any
    // member could spoof another member's ready state in the lobby.
    socket.on('convoy:member_ready', () => {
      void whenReady().then((ok) => {
        if (!ok) return;
        socket.to(`group:${groupId}`).emit('convoy:member_ready', { userId });
      });
    });

    // convoy:start — admin starts the convoy from lobby
    socket.on('convoy:start', async (data: unknown) => {
      const { groupId: payloadGroupId } = (data as { groupId?: string }) ?? {};
      if (!payloadGroupId) return;
      try {
        if (!(await whenReady())) return;
        const group = await fastify.db.query<{ admin_id: string; name: string }>(
          `SELECT admin_id, name FROM convoy_groups WHERE id = $1`,
          [payloadGroupId],
        );
        if (group.rows[0]?.admin_id !== userId) return;
        // Record convoy start time so /end can compute duration
        await fastify.redis.set(`group:${payloadGroupId}:started_at`, String(Date.now()), 'EX', 86400);
        // NotificationCenterScreen renders `${d.groupName ?? 'Your group'} is on the move` —
        // groupName was never included, so it always fell back to the generic text.
        io.to(`group:${payloadGroupId}`).emit('convoy:started', {
          groupId: payloadGroupId,
          startedBy: userId,
          groupName: group.rows[0]?.name,
        });
      } catch (err) {
        fastify.log.error({ err }, 'convoy start error');
      }
    });

    // sos:acknowledge — relay SOS acknowledgment to group
    //
    // sos_hero achievement (target: 1 — "respond to an SOS alert"): this is the
    // one concrete "responding to an SOS" action the app already has. When
    // another member's SosAlertModal is shown (mobile MapScreen.tsx), tapping
    // "Alert Group" or letting its countdown expire fires onAcknowledge, which
    // emits this event. We treat the acknowledging member — the one who saw the
    // alert and responded — as the "hero", and increment their counter here.
    // (The person who *raised* the SOS is not the one credited; this is about
    // group members responding to help someone else.)
    socket.on('sos:acknowledge', (data: unknown) => {
      const { sosId, memberName } = (data as { sosId?: string; memberName?: string }) ?? {};
      if (!sosId) return;
      void whenReady().then((ok) => {
        if (!ok) return;
        handleSosAcknowledge({
          sosId,
          memberName,
          ackUserId: userId,
          groupId,
          redis: fastify.redis,
          db: fastify.db,
          io,
        }).catch((err: unknown) => fastify.log.error({ err }, 'sos acknowledge error'));
      });
    });

    // waypoint:reached — relay waypoint arrival notification to group
    socket.on('waypoint:reached', (data: unknown) => {
      const { waypointId, type, message } =
        (data as { waypointId?: string; type?: string; message?: string }) ?? {};
      if (!waypointId) return;
      void whenReady().then((ok) => {
        if (!ok) return;
        socket.to(`group:${groupId}`).emit('waypoint:reached', { waypointId, type, message, userId });
      });
    });

    // Notify group on disconnect and clean up Redis presence (Req 8.3)
    socket.on('disconnect', () => {
      lastLocUpdate.delete(socket.id);
      // Await setup before cleaning up: orders the offline transition after
      // the connect-time presence write for instantly-dropped connections,
      // and guarantees groupId is the resolved value. A socket that never
      // became authorized (ok === false) set nothing up — skip entirely.
      void whenReady().then((ok) => {
        if (!ok) return;
        // Only mark offline if this socket still owns the user's presence
        // (guard against multi-tab / reconnect races) — setPresenceOffline
        // returns false when a newer socket has taken ownership.
        setPresenceOffline(fastify.redis, userId, socket.id)
          .then((transitioned) => {
            if (!transitioned) return;
            io.to(`group:${groupId}`).emit('presence:update', {
              userId,
              isOnline: false,
              lastSeen: new Date().toISOString(),
            });
          })
          .catch((err: unknown) => fastify.log.error({ err }, 'presence offline error'));
        io.to(`group:${groupId}`).emit('member:left', { userId });
        io.to(`group:${groupId}`).emit('member:offline', { userId, ts: Date.now() });
        fastify.redis.del(`loc:${groupId}:${userId}`).catch((err: unknown) => fastify.log.error({ err }, 'redis del error'));
      });
    });
  };
}
