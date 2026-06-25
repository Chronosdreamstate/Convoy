/**
 * Rally point and SOS routes.
 * Requirements: 20.1–20.6, 25.1–25.7, 37.5
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { authenticate } from '../middleware/authenticate';
import { env } from '../config/env';

// ---------------------------------------------------------------------------
// Interfaces and types
// ---------------------------------------------------------------------------

export interface RawRallyRow {
  id: string;
  broadcaster_id: string;
  lat: number;
  lng: number;
  address: string | null;
  is_active: boolean;
  created_at: Date;
}

export interface RallyResponse {
  id: string;
  broadcasterId: string;
  lat: number;
  lng: number;
  address: string | null;
  isActive: boolean;
  createdAt: string;
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
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SOS_COOLDOWN_S = 60;
const SOS_TTL_S = 7_200; // 2 hours

async function reverseGeocode(lng: number, lat: number): Promise<string | null> {
  try {
    const url =
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json` +
      `?access_token=${env.MAPBOX_API_TOKEN}&limit=1`;
    const res = await fetch(url);
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

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

const rallyRoutes: FastifyPluginAsync = async (fastify) => {
  // ── POST /groups/:id/rally ────────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/groups/:id/rally',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const groupId = request.params.id;

      const bodyParsed = latLngBody.safeParse(request.body);
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
        return reply.status(403).send({ error: 'Not an active group member' });
      }

      // Best-effort reverse geocode (Req 20.2)
      const address = await reverseGeocode(body.lng, body.lat);

      // Persist to DB
      const result = await fastify.db.query<{ id: string; created_at: Date }>(
        `INSERT INTO rally_points (group_id, broadcaster_id, location, address)
         VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5)
         RETURNING id, created_at`,
        [groupId, userId, body.lng, body.lat, address],
      );
      const row = result.rows[0];

      const rallyResponse: RallyResponse = {
        id: row.id,
        broadcasterId: userId,
        lat: body.lat,
        lng: body.lng,
        address,
        isActive: true,
        createdAt: row.created_at.toISOString(),
      };

      // Emit rally:set to group room (Req 20.1, 20.3)
      fastify.io.to(`group:${groupId}`).emit('rally:set', rallyResponse);

      return reply.status(201).send(rallyResponse);
    },
  );

  // ── DELETE /groups/:id/rally/:rallyId ─────────────────────────────────────
  fastify.delete<{ Params: { id: string; rallyId: string } }>(
    '/groups/:id/rally/:rallyId',
    { preHandler: [authenticate] },
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
        return reply.status(403).send({ error: 'Forbidden' });
      }

      // Property 33: guard against double-cancel (Req 20.5)
      if (!canCancelRally(rally.is_active)) {
        return reply.status(409).send({ error: 'Rally already cancelled' });
      }

      await fastify.db.query(
        'UPDATE rally_points SET is_active = false WHERE id = $1',
        [rallyId],
      );

      // Emit rally:cancelled to group room (Req 20.5)
      fastify.io.to(`group:${groupId}`).emit('rally:cancelled', { rallyId, groupId });

      return reply.status(200).send({ success: true, rallyId });
    },
  );

  // ── POST /groups/:id/sos ──────────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/groups/:id/sos',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const groupId = request.params.id;

      const bodyParsed2 = latLngBody.safeParse(request.body);
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
        return reply.status(403).send({ error: 'Not an active group member' });
      }

      // SOS cooldown (Req 37.5)
      const cooldownKey = `sos:cooldown:${userId}`;
      const inCooldown = await fastify.redis.exists(cooldownKey);
      if (inCooldown) {
        return reply.status(429).send({ error: 'SOS cooldown active. Wait 60 seconds.' });
      }

      const sosId = randomUUID();
      const createdAt = new Date().toISOString();
      const sosData = JSON.stringify({ groupId, userId, lat: body.lat, lng: body.lng, createdAt });

      // Persist in Redis atomically via pipeline (transient; clears when group ends)
      const pipeline = fastify.redis.pipeline();
      pipeline.setex(`sos:${sosId}`, SOS_TTL_S, sosData);
      pipeline.setex(`sos:user:${groupId}:${userId}`, SOS_TTL_S, sosId);
      pipeline.setex(cooldownKey, SOS_COOLDOWN_S, '1');
      await pipeline.exec();

      const sosPayload = { id: sosId, userId, groupId, lat: body.lat, lng: body.lng, createdAt };

      // High-priority broadcast to group room (Req 25.1)
      fastify.io.to(`group:${groupId}`).emit('sos:alert', sosPayload);

      // Push for members who may be offline (fire-and-forget)
      fastify.db.query<{ user_id: string }>(
        `SELECT user_id FROM convoy_members WHERE group_id = $1 AND left_at IS NULL AND user_id != $2`,
        [groupId, userId],
      ).then(({ rows }) =>
        Promise.all(rows.map((r) =>
          fastify.enqueueNotification({
            userId: r.user_id,
            type: 'sos_alert',
            title: 'SOS Alert',
            body: 'A group member needs immediate help!',
            data: { sosId, groupId, lat: String(body.lat), lng: String(body.lng) },
          }),
        )),
      ).catch((err: unknown) => fastify.log.error({ err }, 'sos group push failed'));

      return reply.status(201).send(sosPayload);
    },
  );

  // ── DELETE /groups/:id/sos/:sosId ─────────────────────────────────────────
  fastify.delete<{ Params: { id: string; sosId: string } }>(
    '/groups/:id/sos/:sosId',
    { preHandler: [authenticate] },
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
        return reply.status(403).send({ error: 'Forbidden' });
      }

      await fastify.redis.del(`sos:${sosId}`);
      await fastify.redis.del(`sos:user:${groupId}:${sos.userId}`);

      // Emit sos:cancelled removes pin from all Members' maps (Req 25.6)
      fastify.io.to(`group:${groupId}`).emit('sos:cancelled', { sosId, groupId });

      return reply.status(200).send({ success: true, sosId });
    },
  );

  // ── DELETE /sos/:sosId — cancel standalone SOS ───────────────────────────
  fastify.delete<{ Params: { sosId: string } }>(
    '/sos/:sosId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const { sosId } = request.params;

      const sosRaw = await fastify.redis.get(`sos:${sosId}`);
      if (!sosRaw) return reply.status(404).send({ error: 'SOS not found or already expired' });

      const sos = JSON.parse(sosRaw) as { userId: string; groupId: string | null };
      if (sos.userId !== userId) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      await fastify.redis.del(`sos:${sosId}`);

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
  fastify.post('/sos', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const bodyParsed3 = latLngBody.safeParse(request.body);
    if (!bodyParsed3.success) {
      return reply.status(400).send({ error: 'lat and lng are required and must be valid coordinates' });
    }
    const body = bodyParsed3.data;

    // SOS cooldown (Req 37.5)
    const cooldownKey = `sos:cooldown:${userId}`;
    const inCooldown = await fastify.redis.exists(cooldownKey);
    if (inCooldown) {
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
    const sosData = JSON.stringify({ groupId: null, userId, lat: body.lat, lng: body.lng, createdAt });

    const sosPipeline = fastify.redis.pipeline();
    sosPipeline.setex(`sos:${sosId}`, SOS_TTL_S, sosData);
    sosPipeline.setex(cooldownKey, SOS_COOLDOWN_S, '1');
    await sosPipeline.exec();

    const sosPayload = { id: sosId, userId, groupId: null, lat: body.lat, lng: body.lng, createdAt };

    for (const { friend_id } of friendsResult.rows) {
      fastify.io.to(`user:${friend_id}`).emit('sos:alert', sosPayload);
      fastify.enqueueNotification({
        userId: friend_id,
        type: 'sos_alert',
        title: 'SOS Alert',
        body: 'Your friend needs immediate help!',
        data: { sosId, lat: String(body.lat), lng: String(body.lng) },
      }).catch((err: unknown) => fastify.log.error({ err }, 'sos friend push failed'));
    }

    return reply.status(201).send(sosPayload);
  });
};

export default rallyRoutes;
