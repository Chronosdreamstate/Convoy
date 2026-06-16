/**
 * Hazard reporting API
 * Requirements: 11.1–11.10, 37.1
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { authenticate } from '../middleware/authenticate';

// ---------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------

export const HAZARD_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes (Req 11.3)
export const HAZARD_RATE_LIMIT = 10;
export const HAZARD_RATE_WINDOW_S = 3600;

export const HAZARD_TYPES = [
  'pothole', 'accident', 'roadwork', 'debris',
  'animal', 'speed_trap', 'ice', 'flood', 'other',
] as const;

export type HazardType = (typeof HAZARD_TYPES)[number];

export interface RawHazardRow {
  id: string;
  hazard_type: string;
  lat: number;
  lng: number;
  status: string;
  expires_at: Date;
  confirmation_count: number;
  dismissal_count: number;
  created_at: Date;
}

export interface HazardResponse {
  id: string;
  type: string;
  lat: number;
  lng: number;
  status: string;
  expiresAt: string;
  confirmationCount: number;
  dismissalCount: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for property testing
// ---------------------------------------------------------------------------

/** Returns the expiry timestamp 30 minutes from nowMs (Req 11.3, 11.5). */
export function computeExpiresAt(nowMs: number): Date {
  return new Date(nowMs + HAZARD_EXPIRY_MS);
}

/**
 * Given the dismissal count BEFORE the current vote, returns the new count
 * and whether the hazard should be dismissed (>= 3 total, Req 11.6).
 */
export function processDismissal(currentCount: number): { newCount: number; dismissed: boolean } {
  const newCount = currentCount + 1;
  return { newCount, dismissed: newCount >= 3 };
}

/** Returns true when the user is at or within their configured alert distance (Req 11.7). */
export function shouldAlertHazard(distanceMeters: number, thresholdMeters: number): boolean {
  return distanceMeters <= thresholdMeters;
}

/** Serializes a raw DB row to the API response shape. */
export function serializeHazardRow(row: RawHazardRow): HazardResponse {
  return {
    id: row.id,
    type: row.hazard_type,
    lat: row.lat,
    lng: row.lng,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    confirmationCount: row.confirmation_count,
    dismissalCount: row.dismissal_count,
    createdAt: row.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Internal rate-limit helper
// ---------------------------------------------------------------------------

async function checkRateLimit(redis: Redis, userId: string): Promise<boolean> {
  const key = `rate:hazard:${userId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, HAZARD_RATE_WINDOW_S);
  return count <= HAZARD_RATE_LIMIT;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default async function hazardsRoutes(fastify: FastifyInstance): Promise<void> {
  const pool: Pool = fastify.db;
  const redis: Redis = fastify.redis;

  // POST /hazards — create hazard report (Req 11.1)
  fastify.post('/hazards', { preHandler: authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { type, lat, lng } = request.body as { type: string; lat: number; lng: number };

    if (!HAZARD_TYPES.includes(type as HazardType)) {
      return reply.badRequest(`Invalid hazard type. Must be one of: ${HAZARD_TYPES.join(', ')}`);
    }
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return reply.badRequest('lat and lng must be numbers');
    }

    const allowed = await checkRateLimit(redis, userId);
    if (!allowed) {
      return reply.tooManyRequests('Hazard submission rate limit exceeded (10 per hour)');
    }

    const expiresAt = computeExpiresAt(Date.now());

    const result = await pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO hazard_reports (reporter_id, hazard_type, location, expires_at)
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5)
       RETURNING id, created_at`,
      [userId, type, lng, lat, expiresAt],
    );

    const row = result.rows[0];
    const payload: HazardResponse = {
      id: row.id,
      type,
      lat,
      lng,
      status: 'active',
      expiresAt: expiresAt.toISOString(),
      confirmationCount: 0,
      dismissalCount: 0,
      createdAt: row.created_at.toISOString(),
    };

    // Broadcast to all connected sockets; clients filter by location (Req 11.2)
    fastify.io.emit('hazard:new', payload);

    return reply.code(201).send(payload);
  });

  // GET /hazards?lat=&lng=&radius= — active hazards by proximity (Req 11.4)
  fastify.get('/hazards', { preHandler: authenticate }, async (request, reply) => {
    const { lat, lng, radius } = request.query as {
      lat?: string; lng?: string; radius?: string;
    };

    if (!lat || !lng) return reply.badRequest('lat and lng are required');

    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    const radiusM = radius ? parseFloat(radius) : 5000;

    if (isNaN(latNum) || isNaN(lngNum) || isNaN(radiusM)) {
      return reply.badRequest('lat, lng, and radius must be valid numbers');
    }

    const result = await pool.query<RawHazardRow>(
      `SELECT
         id, hazard_type,
         ST_Y(location::geometry) AS lat,
         ST_X(location::geometry) AS lng,
         status, expires_at, confirmation_count, dismissal_count, created_at
       FROM hazard_reports
       WHERE status = 'active'
         AND expires_at > now()
         AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
       ORDER BY created_at DESC`,
      [lngNum, latNum, radiusM],
    );

    return result.rows.map(serializeHazardRow);
  });

  // POST /hazards/bulk — sync offline queue (no rate limit) — MUST be before /:id routes
  fastify.post('/hazards/bulk', { preHandler: authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { hazards } = request.body as {
      hazards: Array<{ type: string; lat: number; lng: number; createdAt?: number }>;
    };

    if (!Array.isArray(hazards) || hazards.length === 0) {
      return reply.badRequest('hazards must be a non-empty array');
    }

    const inserted: string[] = [];
    for (const h of hazards) {
      if (!HAZARD_TYPES.includes(h.type as HazardType)) continue;
      const created = h.createdAt ? new Date(h.createdAt) : new Date();
      const expires = computeExpiresAt(created.getTime());
      const r = await pool.query<{ id: string }>(
        `INSERT INTO hazard_reports (reporter_id, hazard_type, location, expires_at, created_at)
         VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6)
         RETURNING id`,
        [userId, h.type, h.lng, h.lat, expires, created],
      );
      inserted.push(r.rows[0].id);
    }

    return reply.code(201).send({ inserted, count: inserted.length });
  });

  // POST /hazards/:id/confirm — confirm a report (Req 11.5)
  fastify.post('/hazards/:id/confirm', { preHandler: authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };

    // Prevent double-voting via hazard_votes unique constraint
    const existing = await pool.query(
      `SELECT 1 FROM hazard_votes WHERE hazard_id = $1 AND user_id = $2`,
      [id, userId],
    );
    if ((existing.rowCount ?? 0) > 0) {
      return reply.conflict('Already voted on this hazard');
    }

    await pool.query(
      `INSERT INTO hazard_votes (hazard_id, user_id, vote) VALUES ($1, $2, 'confirm')`,
      [id, userId],
    );

    const expiresAt = computeExpiresAt(Date.now());

    const result = await pool.query<{ id: string; confirmation_count: number }>(
      `UPDATE hazard_reports
       SET confirmation_count = confirmation_count + 1,
           expires_at = $2,
           updated_at = now()
       WHERE id = $1 AND status = 'active'
       RETURNING id, confirmation_count`,
      [id, expiresAt],
    );

    if ((result.rowCount ?? 0) === 0) return reply.notFound('Hazard not found or already resolved');

    return {
      id,
      confirmationCount: result.rows[0].confirmation_count,
      expiresAt: expiresAt.toISOString(),
    };
  });

  // POST /hazards/:id/dismiss — dismiss a report (Req 11.6)
  fastify.post('/hazards/:id/dismiss', { preHandler: authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };

    // Prevent double-voting
    const existing = await pool.query(
      `SELECT 1 FROM hazard_votes WHERE hazard_id = $1 AND user_id = $2`,
      [id, userId],
    );
    if ((existing.rowCount ?? 0) > 0) {
      return reply.conflict('Already voted on this hazard');
    }

    await pool.query(
      `INSERT INTO hazard_votes (hazard_id, user_id, vote) VALUES ($1, $2, 'dismiss')`,
      [id, userId],
    );

    // Atomically increment and update status when threshold reached (Req 11.6)
    const result = await pool.query<{ id: string; dismissal_count: number; status: string }>(
      `UPDATE hazard_reports
       SET dismissal_count = dismissal_count + 1,
           status = CASE WHEN dismissal_count + 1 >= 3 THEN 'dismissed' ELSE status END,
           updated_at = now()
       WHERE id = $1 AND status = 'active'
       RETURNING id, dismissal_count, status`,
      [id],
    );

    if ((result.rowCount ?? 0) === 0) return reply.notFound('Hazard not found or already resolved');

    const row = result.rows[0];
    const wasDismissed = row.status === 'dismissed';

    if (wasDismissed) {
      fastify.io.emit('hazard:expired', { id });
    }

    return { id, dismissalCount: row.dismissal_count, status: row.status };
  });
}
