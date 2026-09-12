/**
 * Rally point and SOS routes.
 * Requirements: 20.1–20.6, 25.1–25.7, 37.5
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';
import { env } from '../config/env';

// ---------------------------------------------------------------------------
// Interfaces and types
// ---------------------------------------------------------------------------

export type RallyPointType = 'waypoint' | 'meetup' | 'fuel' | 'rest' | 'photo';

export interface RawRallyRow {
  id: string;
  broadcaster_id: string;
  lat: number;
  lng: number;
  address: string | null;
  is_active: boolean;
  created_at: Date;
  type?: RallyPointType;
}

export interface RallyResponse {
  id: string;
  broadcasterId: string;
  lat: number;
  lng: number;
  address: string | null;
  isActive: boolean;
  createdAt: string;
  type: RallyPointType;
}

// ---------------------------------------------------------------------------
// Pure exports (property-testable)
// ---------------------------------------------------------------------------

/** Property 34: rally broadcast requires an active group membership. */
export function canBroadcastRally(hasActiveGroup: boolean): boolean {
  return hasActiveGroup;
}

/** Property 33: only a currently-active rally can be cancelled. */
export function canCancelRally(isActive: boolean): boolean {
  return isActive;
}

/** Property 41: SOS cancellation is permitted only by its owner or the group admin. */
export function canCancelSos(params: {
  requesterId: string;
  sosOwnerId: string;
  groupAdminId: string | null;
}): boolean {
  const { requesterId, sosOwnerId, groupAdminId } = params;
  return (
    requesterId === sosOwnerId ||
    (groupAdminId !== null && requesterId === groupAdminId)
  );
}

/** Serialise a raw DB row into the client-facing rally response shape. */
export function serializeRallyRow(row: RawRallyRow): RallyResponse {
  return {
    id: row.id,
    broadcasterId: row.broadcaster_id,
    lat: row.lat,
    lng: row.lng,
    address: row.address,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    type: row.type ?? 'waypoint',
  };
}

/** Anything that can run a parameterised query — the pool or a transaction client. */
interface RallyQueryable {
  query(text: string, values: unknown[]): Promise<{ rows: Array<{ id: string }> }>;
}

/**
 * Deactivates every currently-active rally point for the group and returns
 * their ids, so the caller can emit `rally:cancelled` for each and every
 * Member's map drops the old pin the moment a new one is broadcast. Req 20.3
 * defines "the active Rally_Point" (singular): without this a second broadcast
 * left the first row is_active = true and its pin on every Member's map
 * forever — stale pins accumulated and Members could navigate to an outdated
 * rally.
 *
 * Takes any queryable so the retire and the new rally's INSERT can share one
 * transaction (see POST below). Exported for tests.
 */
export async function deactivateActiveRallies(
  db: RallyQueryable,
  groupId: string,
): Promise<string[]> {
  const result = await db.query(
    'UPDATE rally_points SET is_active = false WHERE group_id = $1 AND is_active = true RETURNING id',
    [groupId],
  );
  return result.rows.map((r) => r.id);
}

/**
 * Lists the group's active SOS pins from Redis (the pins live only in Redis
 * with a 2h TTL). Backfill path for Members who join late or reconnect after
 * being backgrounded/killed — previously SOS pins were ONLY delivered via the
 * live `sos:alert` socket push, so a Member who missed that broadcast had no
 * way to see an ongoing emergency on their map (Req 25.4).
 * Exported for tests.
 */
export async function getActiveGroupSos(
  db: Pool,
  redis: Redis,
  groupId: string,
): Promise<Array<{
  id: string; userId: string; groupId: string; lat: number; lng: number;
  type: string; createdAt: string; senderName?: string;
}>> {
  const membersResult = await db.query<{ user_id: string }>(
    'SELECT user_id FROM convoy_members WHERE group_id = $1 AND left_at IS NULL',
    [groupId],
  );
  const memberIds = membersResult.rows.map((r) => r.user_id);
  if (memberIds.length === 0) return [];

  // sos:user:<groupId>:<userId> → sosId (written by POST /groups/:id/sos)
  const sosIds = (
    await redis.mget(...memberIds.map((uid) => `sos:user:${groupId}:${uid}`))
  ).filter((id): id is string => id !== null && id !== undefined);
  if (sosIds.length === 0) return [];

  const rawPins = await redis.mget(...sosIds.map((id) => `sos:${id}`));

  const pins: Array<{
    id: string; userId: string; groupId: string; lat: number; lng: number;
    type: string; createdAt: string; senderName?: string;
  }> = [];
  for (let i = 0; i < sosIds.length; i++) {
    const raw = rawPins[i];
    if (!raw) continue; // pin expired between the two lookups
    try {
      const sos = JSON.parse(raw) as {
        userId: string; lat: number; lng: number; type?: string; createdAt: string;
      };
      pins.push({
        id: sosIds[i],
        userId: sos.userId,
        groupId,
        lat: sos.lat,
        lng: sos.lng,
        type: sos.type ?? 'general',
        createdAt: sos.createdAt,
      });
    } catch { /* skip malformed entry */ }
  }
  if (pins.length === 0) return [];

  // Req 25.5: identify the transmitting Member by name.
  const namesResult = await db.query<{ id: string; display_name: string; ptt_callsign: string | null }>(
    'SELECT id, display_name, ptt_callsign FROM users WHERE id = ANY($1)',
    [pins.map((p) => p.userId)],
  );
  const nameById = new Map(
    namesResult.rows.map((r) => [r.id, r.ptt_callsign ?? r.display_name]),
  );
  for (const pin of pins) {
    const name = nameById.get(pin.userId);
    if (name) pin.senderName = name;
  }
  return pins;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SOS_COOLDOWN_S = 60;
const SOS_TTL_S = 7_200; // 2 hours

// Reverse geocoding is best-effort decoration on rally creation; a hung Mapbox
// connection must never stall the rally response, so cap the fetch (matches
// the 5s reverse-geocode timeout in places.routes.ts) and fail soft to null.
export const REVERSE_GEOCODE_TIMEOUT_MS = 5_000;

/** Exported for tests. Fails soft to null on any error, including timeout/abort. */
export async function reverseGeocode(lng: number, lat: number): Promise<string | null> {
  try {
    const url =
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json` +
      `?access_token=${env.MAPBOX_API_TOKEN}&limit=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(REVERSE_GEOCODE_TIMEOUT_MS) });
    const data = (await res.json()) as { features: Array<{ place_name: string }> };
    return data.features[0]?.place_name ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Request body schemas
// ---------------------------------------------------------------------------

const latLngBody = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

// Rally point creation accepts an optional type — the mobile client (RallyService.
// broadcastRally) always sends one to pick the marker emoji (RALLY_EMOJI), but the
// server previously used the plain latLngBody schema, silently discarding it.
const rallyBody = latLngBody.extend({
  type: z.enum(['waypoint', 'meetup', 'fuel', 'rest', 'photo']).optional().default('waypoint'),
});

// SOS creation accepts an optional emergency type — the mobile client (RallyService.
// broadcastGroupSos/broadcastStandaloneSos) always sends one, but the server previously
// used the plain latLngBody schema, silently discarding it: never persisted, never
// returned in the response, and never included in the sos:alert broadcast, even though
// the client's SosPin type declares `type` as a required field.
const sosBody = latLngBody.extend({
  type: z.enum(['breakdown', 'accident', 'medical', 'fuel', 'general']).optional().default('general'),
});

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

const rallyRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /groups/:id/rally ────────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/groups/:id/rally',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const groupId = request.params.id;

      const bodyParsed = rallyBody.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({ error: 'lat and lng are required and must be valid coordinates' });
      }
      const body = bodyParsed.data;

      // Property 34: must be an active group member (Req 20.6)
      const memberResult = await fastify.db.query<{ id: string }>(
        `SELECT cm.id
         FROM convoy_members cm
         WHERE cm.group_id = $1 AND cm.user_id = $2 AND cm.left_at IS NULL`,
        [groupId, userId],
      );
      if (!canBroadcastRally(memberResult.rows.length > 0)) {
        return reply.status(403).send({ error: 'You are not a member of this group' });
      }

      // Best-effort reverse geocode (Req 20.2)
      const address = await reverseGeocode(body.lng, body.lat);

      // One active rally per group (Req 20.3): retire any previous rally and
      // tell every Member's map to drop its pin before the new one lands.
      //
      // Retire + insert must be one transaction serialised per group: two
      // Members long-pressing "Set rally point" at the same moment each ran the
      // deactivate (neither seeing the other's uncommitted row) and then each
      // inserted is_active = true, leaving TWO active rally points. Both
      // `rally:set` broadcasts landed and no `rally:cancelled` ever followed, so
      // every Member's map carried two rally pins and different riders navigated
      // to different ones. The advisory lock (same per-key pattern as
      // vehicles.routes.ts) makes the loser's deactivate see the winner's
      // committed row; migration 036's partial unique index is the hard backstop.
      const client = await fastify.db.connect();
      let cancelledIds: string[];
      let row: { id: string; created_at: Date };
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`rally:${groupId}`]);

        cancelledIds = await deactivateActiveRallies(client, groupId);

        const result = await client.query<{ id: string; created_at: Date }>(
          `INSERT INTO rally_points (group_id, broadcaster_id, location, address, type)
           VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6)
           RETURNING id, created_at`,
          [groupId, userId, body.lng, body.lat, address, body.type],
        );
        row = result.rows[0];

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Emitted after the commit so a Member never drops the old pin for a
      // rally change that then rolled back.
      for (const rallyId of cancelledIds) {
        fastify.io.to(`group:${groupId}`).emit('rally:cancelled', { rallyId, groupId });
      }

      const rallyResponse: RallyResponse = {
        id: row.id,
        broadcasterId: userId,
        lat: body.lat,
        lng: body.lng,
        address,
        isActive: true,
        createdAt: row.created_at.toISOString(),
        type: body.type,
      };

      // Emit rally:set to group room (Req 20.1, 20.3)
      fastify.io.to(`group:${groupId}`).emit('rally:set', rallyResponse);

      // Push for members who may be offline/backgrounded (fire-and-forget).
      fastify.db.query<{ user_id: string }>(
        `SELECT user_id FROM convoy_members WHERE group_id = $1 AND left_at IS NULL AND user_id != $2`,
        [groupId, userId],
      ).then(({ rows }) =>
        Promise.all(rows.map((r) =>
          fastify.enqueueNotification({
            userId: r.user_id,
            type: 'rally_point',
            title: 'Rally Point Set',
            body: 'A rally point has been set for your group',
            data: { groupId, rallyId: row.id, broadcasterId: userId, lat: String(body.lat), lng: String(body.lng) },
          }),
        )),
      ).catch((err: unknown) => fastify.log.error({ err }, 'rally point push failed'));

      return reply.status(201).send(rallyResponse);
    },
  );

  // ── GET /groups/:id/rally/active ──────────────────────────────────────────
  // Backfills the currently-active rally point for members who join late or
  // reconnect after being backgrounded/killed — previously rally points were
  // ONLY ever delivered via the live `rally:set` socket push, so a Member who
  // missed that broadcast had no way to learn one was active (Req 20.1, 20.3).
  // Must be registered before /groups/:id/rally/:rallyId so "active" doesn't
  // get captured as a :rallyId param — Fastify's static-segment routing
  // handles this correctly regardless of declaration order, but the comment
  // documents the intent for future routes added here.
  fastify.get<{ Params: { id: string } }>(
    '/groups/:id/rally/active',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const groupId = request.params.id;

      // Must be an active group member to view group state (mirrors POST's check).
      const memberResult = await fastify.db.query<{ id: string }>(
        `SELECT cm.id
         FROM convoy_members cm
         WHERE cm.group_id = $1 AND cm.user_id = $2 AND cm.left_at IS NULL`,
        [groupId, userId],
      );
      if (memberResult.rows.length === 0) {
        return reply.status(403).send({ error: 'You are not a member of this group' });
      }

      // At most one rally point is active per group at a time — POST retires the
      // previous one in the same transaction and uq_rally_points_one_active
      // (migration 036) enforces it — so the newest active row is the current one.
      const result = await fastify.db.query<RawRallyRow>(
        `SELECT
           rp.id, rp.broadcaster_id, rp.address, rp.is_active, rp.created_at, rp.type,
           ST_Y(rp.location::geometry) AS lat,
           ST_X(rp.location::geometry) AS lng
         FROM rally_points rp
         WHERE rp.group_id = $1 AND rp.is_active = true
         ORDER BY rp.created_at DESC
         LIMIT 1`,
        [groupId],
      );

      const row = result.rows[0];
      return reply.status(200).send({ rallyPoint: row ? serializeRallyRow(row) : null });
    },
  );

  // ── DELETE /groups/:id/rally/:rallyId ─────────────────────────────────────
  fastify.delete<{ Params: { id: string; rallyId: string } }>(
    '/groups/:id/rally/:rallyId',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const { id: groupId, rallyId } = request.params;

      const rallyResult = await fastify.db.query<{
        id: string;
        broadcaster_id: string;
        is_active: boolean;
        group_admin_id: string;
      }>(
        `SELECT rp.id, rp.broadcaster_id, rp.is_active, cg.admin_id AS group_admin_id
         FROM rally_points rp
         JOIN convoy_groups cg ON cg.id = rp.group_id
         WHERE rp.id = $1 AND rp.group_id = $2`,
        [rallyId, groupId],
      );
      const rally = rallyResult.rows[0];
      if (!rally) return reply.status(404).send({ error: 'Rally point not found' });

      if (rally.broadcaster_id !== userId && rally.group_admin_id !== userId) {
        return reply.status(403).send({ error: 'Only the person who set this rally point or the group Admin can cancel it' });
      }

      // Property 33: guard against double-cancel (Req 20.5)
      if (!canCancelRally(rally.is_active)) {
        return reply.status(409).send({ error: 'Rally already cancelled' });
      }

      // The check above is a read, so the broadcaster and the Admin both
      // tapping "Cancel rally" at the same moment both passed it and both
      // broadcast rally:cancelled. Let the UPDATE decide: only the caller that
      // actually flips is_active announces the cancellation, the other gets the
      // same 409 a late second tap already gets.
      const cancelled = await fastify.db.query(
        'UPDATE rally_points SET is_active = false WHERE id = $1 AND is_active = true RETURNING id',
        [rallyId],
      );
      if ((cancelled.rowCount ?? 0) === 0) {
        return reply.status(409).send({ error: 'Rally already cancelled' });
      }

      // Emit rally:cancelled to group room (Req 20.5)
      fastify.io.to(`group:${groupId}`).emit('rally:cancelled', { rallyId, groupId });

      return reply.status(200).send({ success: true, rallyId });
    },
  );

  // ── POST /groups/:id/sos ──────────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/groups/:id/sos',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const groupId = request.params.id;

      const bodyParsed2 = sosBody.safeParse(request.body);
      if (!bodyParsed2.success) {
        return reply.status(400).send({ error: 'lat and lng are required and must be valid coordinates' });
      }
      const body = bodyParsed2.data;

      // Active member check
      const memberResult = await fastify.db.query<{ id: string }>(
        `SELECT cm.id
         FROM convoy_members cm
         WHERE cm.group_id = $1 AND cm.user_id = $2 AND cm.left_at IS NULL`,
        [groupId, userId],
      );
      if (memberResult.rows.length === 0) {
        return reply.status(403).send({ error: 'You are not a member of this group' });
      }

      // SOS cooldown (Req 37.5) — claimed atomically with SET NX, not
      // EXISTS-then-SETEX. Two taps a few hundred ms apart (the SOS button is
      // held under stress, and a queued SOS can flush at the same moment as a
      // live one) both passed the old EXISTS check before either wrote the key,
      // so both broadcast. The second overwrote sos:user:<group>:<user>, which
      // is the only handle the cancel path has: cancelling cleared one pin while
      // the other stayed on every Member's map — an emergency that cannot be
      // stood down — until its 2h TTL expired.
      const cooldownKey = `sos:cooldown:${userId}`;
      const claimed = await fastify.redis.set(cooldownKey, '1', 'EX', SOS_COOLDOWN_S, 'NX');
      if (!claimed) {
        return reply.status(429).send({ error: 'SOS cooldown active. Wait 60 seconds.' });
      }

      const sosId = randomUUID();
      const createdAt = new Date().toISOString();
      const sosData = JSON.stringify({ groupId, userId, lat: body.lat, lng: body.lng, type: body.type, createdAt });

      // Persist in Redis atomically via pipeline (transient; clears when group ends).
      // The cooldown key is already set by the claim above.
      const pipeline = fastify.redis.pipeline();
      pipeline.setex(`sos:${sosId}`, SOS_TTL_S, sosData);
      pipeline.setex(`sos:user:${groupId}:${userId}`, SOS_TTL_S, sosId);
      await pipeline.exec();

      // Req 25.5: the alert must identify the transmitting Member by name — fetched
      // up front so the live socket payload (not just the push) carries it too;
      // recipients outside the sender's cached member list (e.g. a Member who just
      // joined) otherwise render a truncated userId instead of a name.
      const senderResult = await fastify.db.query<{ display_name: string; ptt_callsign: string | null }>(
        'SELECT display_name, ptt_callsign FROM users WHERE id = $1',
        [userId],
      );
      const senderName = senderResult.rows[0]?.ptt_callsign ?? senderResult.rows[0]?.display_name ?? 'A group member';

      const sosPayload = { id: sosId, userId, groupId, lat: body.lat, lng: body.lng, type: body.type, createdAt, senderName };

      // High-priority broadcast to group room (Req 25.1)
      fastify.io.to(`group:${groupId}`).emit('sos:alert', sosPayload);

      // Push for members who may be offline (fire-and-forget).
      fastify.db.query<{ user_id: string }>(
        `SELECT user_id FROM convoy_members WHERE group_id = $1 AND left_at IS NULL AND user_id != $2`,
        [groupId, userId],
      ).then(({ rows }) =>
        Promise.all(rows.map((r) =>
          fastify.enqueueNotification({
            userId: r.user_id,
            type: 'sos_alert',
            title: 'SOS Alert',
            body: `${senderName} needs immediate help!`,
            data: { sosId, groupId, senderId: userId, senderName, lat: String(body.lat), lng: String(body.lng) },
          }),
        )),
      ).catch((err: unknown) => fastify.log.error({ err }, 'sos group push failed'));

      return reply.status(201).send(sosPayload);
    },
  );

  // ── GET /groups/:id/sos/active ────────────────────────────────────────────
  // Backfills the group's active SOS pins for Members who join late or
  // reconnect after being backgrounded/killed (Req 25.4) — mirrors
  // GET /groups/:id/rally/active. Live `sos:alert` pushes remain the primary
  // delivery path; this is the recovery path for anyone who missed them.
  fastify.get<{ Params: { id: string } }>(
    '/groups/:id/sos/active',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const groupId = request.params.id;

      // Must be an active group member to view group state (mirrors POST's check).
      const memberResult = await fastify.db.query<{ id: string }>(
        `SELECT cm.id
         FROM convoy_members cm
         WHERE cm.group_id = $1 AND cm.user_id = $2 AND cm.left_at IS NULL`,
        [groupId, userId],
      );
      if (memberResult.rows.length === 0) {
        return reply.status(403).send({ error: 'You are not a member of this group' });
      }

      const sosPins = await getActiveGroupSos(fastify.db, fastify.redis, groupId);
      return reply.status(200).send({ sosPins });
    },
  );

  // ── DELETE /groups/:id/sos/:sosId ─────────────────────────────────────────
  fastify.delete<{ Params: { id: string; sosId: string } }>(
    '/groups/:id/sos/:sosId',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const { id: groupId, sosId } = request.params;

      const sosRaw = await fastify.redis.get(`sos:${sosId}`);
      if (!sosRaw) return reply.status(404).send({ error: 'SOS not found or already expired' });

      const sos = JSON.parse(sosRaw) as {
        groupId: string;
        userId: string;
        lat: number;
        lng: number;
        createdAt: string;
      };

      // Verify SOS belongs to the group specified in the URL
      if (sos.groupId !== groupId) {
        return reply.status(404).send({ error: 'SOS not found or already expired' });
      }

      const groupResult = await fastify.db.query<{ admin_id: string }>(
        'SELECT admin_id FROM convoy_groups WHERE id = $1',
        [groupId],
      );
      const groupAdminId = groupResult.rows[0]?.admin_id ?? null;

      // Property 41: only owner or admin can cancel (Req 25.6)
      if (!canCancelSos({ requesterId: userId, sosOwnerId: sos.userId, groupAdminId })) {
        return reply.status(403).send({ error: 'Only the person who sent this SOS or the group Admin can cancel it' });
      }

      // DEL returns how many keys it removed, so it doubles as the claim: the
      // rider standing their own SOS down while the Admin clears it for them
      // both read the pin above and both announced the stand-down. Only the
      // caller whose DEL actually removed the pin emits.
      const removed = await fastify.redis.del(`sos:${sosId}`);
      if (removed === 0) {
        return reply.status(404).send({ error: 'SOS not found or already expired' });
      }
      await fastify.redis.del(`sos:user:${groupId}:${sos.userId}`);

      // Emit sos:cancelled removes pin from all Members' maps (Req 25.6)
      fastify.io.to(`group:${groupId}`).emit('sos:cancelled', { sosId, groupId });

      return reply.status(200).send({ success: true, sosId });
    },
  );

  // ── DELETE /sos/:sosId — cancel standalone SOS ───────────────────────────
  fastify.delete<{ Params: { sosId: string } }>(
    '/sos/:sosId',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const { sosId } = request.params;

      const sosRaw = await fastify.redis.get(`sos:${sosId}`);
      if (!sosRaw) return reply.status(404).send({ error: 'SOS not found or already expired' });

      const sos = JSON.parse(sosRaw) as { userId: string; groupId: string | null };
      if (sos.userId !== userId) {
        return reply.status(403).send({ error: 'You can only cancel an SOS you sent' });
      }

      // Same claim-by-DEL as the group cancel above — only the caller that
      // removed the pin tells the sender's friends it is over. Reachable here
      // by one rider standing the same SOS down from two devices.
      const removed = await fastify.redis.del(`sos:${sosId}`);
      if (removed === 0) {
        return reply.status(404).send({ error: 'SOS not found or already expired' });
      }

      // Notify friends that SOS was cancelled
      const friendsResult = await fastify.db.query<{ friend_id: string }>(
        `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS friend_id
         FROM friendships
         WHERE (requester_id = $1 OR addressee_id = $1) AND status = 'accepted'`,
        [userId],
      );
      for (const { friend_id } of friendsResult.rows) {
        fastify.io.to(`user:${friend_id}`).emit('sos:cancelled', { sosId, groupId: null });
      }

      return reply.status(200).send({ success: true, sosId });
    },
  );

  // ── POST /sos — standalone SOS (no active group) ─────────────────────────
  fastify.post('/sos', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const bodyParsed3 = sosBody.safeParse(request.body);
    if (!bodyParsed3.success) {
      return reply.status(400).send({ error: 'lat and lng are required and must be valid coordinates' });
    }
    const body = bodyParsed3.data;

    // SOS cooldown (Req 37.5) — same atomic claim as the group SOS above: an
    // EXISTS-then-SETEX pair let two near-simultaneous taps both through, and
    // every friend then got two alerts and two pins for one emergency, only one
    // of which the sender's client could ever cancel.
    const cooldownKey = `sos:cooldown:${userId}`;
    const claimed = await fastify.redis.set(cooldownKey, '1', 'EX', SOS_COOLDOWN_S, 'NX');
    if (!claimed) {
      return reply.status(429).send({ error: 'SOS cooldown active. Wait 60 seconds.' });
    }

    // Fetch accepted friends (Req 25.7)
    const friendsResult = await fastify.db.query<{ friend_id: string }>(
      `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS friend_id
       FROM friendships
       WHERE (requester_id = $1 OR addressee_id = $1) AND status = 'accepted'`,
      [userId],
    );

    const sosId = randomUUID();
    const createdAt = new Date().toISOString();
    const sosData = JSON.stringify({ groupId: null, userId, lat: body.lat, lng: body.lng, type: body.type, createdAt });

    const sosPipeline = fastify.redis.pipeline();
    sosPipeline.setex(`sos:${sosId}`, SOS_TTL_S, sosData);
    await sosPipeline.exec();

    // Req 25.5: identify the transmitting Member by name — in the socket payload
    // as well as the push, since recipients are friends who have no group member
    // list to resolve the sender's userId against.
    const senderResult = await fastify.db.query<{ display_name: string; ptt_callsign: string | null }>(
      'SELECT display_name, ptt_callsign FROM users WHERE id = $1',
      [userId],
    );
    const senderName = senderResult.rows[0]?.ptt_callsign ?? senderResult.rows[0]?.display_name ?? 'Your friend';

    const sosPayload = { id: sosId, userId, groupId: null, lat: body.lat, lng: body.lng, type: body.type, createdAt, senderName };

    for (const { friend_id } of friendsResult.rows) {
      fastify.io.to(`user:${friend_id}`).emit('sos:alert', sosPayload);
      fastify.enqueueNotification({
        userId: friend_id,
        type: 'sos_alert',
        title: 'SOS Alert',
        body: `${senderName} needs immediate help!`,
        data: { sosId, senderId: userId, senderName, lat: String(body.lat), lng: String(body.lng) },
      }).catch((err: unknown) => fastify.log.error({ err }, 'sos friend push failed'));
    }

    return reply.status(201).send(sosPayload);
  });
};

export default rallyRoutes;

