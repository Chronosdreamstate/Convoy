/**
 * Hazard reporting API
 * Requirements: 11.1–11.10, 37.1
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import {
  generalLimiter,
  hazardReportLimiter,
  hazardReportLimit,
  rateLimitKey,
} from '../middleware/rateLimiter';

// ---------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------

export const HAZARD_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes (Req 11.3)
// Sourced from the shared limiter config (Req 37.1) so the bulk endpoint's
// batch accounting can never drift from the per-request limiter.
export const HAZARD_RATE_LIMIT = hazardReportLimit.max;
export const HAZARD_RATE_WINDOW_S = hazardReportLimit.windowS;

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
// Request schemas
// ---------------------------------------------------------------------------

const createHazardSchema = z.object({
  type: z.enum(HAZARD_TYPES),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  severity: z.enum(['low', 'medium', 'high']).optional().default('medium'),
  note: z.string().max(100).optional(),
});

const bulkHazardItemSchema = z.object({
  type: z.enum(HAZARD_TYPES),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  createdAt: z.number().int().positive().optional(),
});

const bulkHazardsSchema = z.object({
  hazards: z.array(bulkHazardItemSchema).min(1).max(100),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default async function hazardsRoutes(fastify: FastifyInstance): Promise<void> {
  const pool: Pool = fastify.db;
  const redis: Redis = fastify.redis;

  // POST /hazards — create hazard report (Req 11.1)
  // Rate limited to 10 reports per user per hour (Req 37.1).
  fastify.post('/hazards', { preHandler: [authenticate, generalLimiter(fastify.redis), hazardReportLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const parsed = createHazardSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.errors[0].message);
    }
    const { type, lat, lng, severity, note } = parsed.data;

    const expiresAt = computeExpiresAt(Date.now());

    const result = await pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO hazard_reports (reporter_id, hazard_type, location, expires_at, severity, note)
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6, $7)
       RETURNING id, created_at`,
      [userId, type, lng, lat, expiresAt, severity, note ?? null],
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
  fastify.get('/hazards', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
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
    if (latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
      return reply.badRequest('lat must be -90 to 90 and lng must be -180 to 180');
    }
    const cappedRadiusM = Math.min(radiusM, 50_000);

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
      [lngNum, latNum, cappedRadiusM],
    );

    return { hazards: result.rows.map(serializeHazardRow) };
  });

  // POST /hazards/bulk — sync offline queue — MUST be before /:id routes
  fastify.post('/hazards/bulk', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const bulkParsed = bulkHazardsSchema.safeParse(request.body);
    if (!bulkParsed.success) {
      return reply.badRequest(bulkParsed.error.errors[0].message);
    }
    const { hazards } = bulkParsed.data;

    // Apply rate limit for the entire batch atomically — same bucket as the
    // per-request hazardReportLimiter on POST /hazards (Req 37.1).
    //
    // PARTIAL acceptance, not all-or-nothing. A driver who reported 12 hazards
    // across a three-hour dead zone used to get a flat 429 for the whole batch
    // on every reconnect: the client re-sent all 12 next time, went over the
    // hourly cap again, and the backlog could never drain — the reports were
    // stuck forever. Now the batch is trimmed to whatever quota is left, the
    // rest stay queued on the device, and the response says how many landed so
    // the client clears exactly those (Req 11.10).
    const rateKey = rateLimitKey(hazardReportLimit.prefix, userId);
    const afterBulk = await redis.incrby(rateKey, hazards.length);
    if (afterBulk === hazards.length) await redis.expire(rateKey, HAZARD_RATE_WINDOW_S);

    const usedBeforeBatch = afterBulk - hazards.length;
    const remainingQuota = Math.max(0, HAZARD_RATE_LIMIT - usedBeforeBatch);
    const accepted = hazards.slice(0, remainingQuota);
    const deferred = hazards.length - accepted.length;
    if (deferred > 0) await redis.decrby(rateKey, deferred);

    if (accepted.length === 0) {
      return reply.tooManyRequests(`Rate limit exceeded: max ${HAZARD_RATE_LIMIT} hazard reports per hour`);
    }

    const now = Date.now();

    // Wrap all inserts in a transaction so a partial failure leaves no orphaned rows
    const client = await pool.connect();
    const inserted: string[] = [];
    const insertedPayloads: HazardResponse[] = [];
    try {
      await client.query('BEGIN');
      for (const h of accepted) {
        // Clamp future timestamps to now so offline reports don't expire immediately
        const created = h.createdAt ? new Date(Math.min(h.createdAt, now)) : new Date();
        const expires = computeExpiresAt(created.getTime());
        // Skip a report this user already filed at the same spot and instant.
        // This endpoint is replayed at least once by design: if the response is
        // lost after the transaction commits (dead zone drops the connection
        // mid-reply), the device still holds the batch and re-sends it, which
        // used to insert a second copy of every hazard AND re-broadcast it to
        // the convoy. A replay carries byte-identical reporter/type/location/
        // createdAt, so that tuple is the natural idempotency key — no client
        // change and no new column needed. Guarded rather than a UNIQUE index
        // because several genuinely distinct offline reports can share a
        // created_at once the clamp above pins future timestamps to `now`.
        const r = await client.query<{ id: string }>(
          `INSERT INTO hazard_reports (reporter_id, hazard_type, location, expires_at, created_at)
           SELECT $1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6
           WHERE NOT EXISTS (
             SELECT 1 FROM hazard_reports
             WHERE reporter_id = $1
               AND hazard_type = $2
               AND created_at = $6
               AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, 1)
           )
           RETURNING id`,
          [userId, h.type, h.lng, h.lat, expires, created],
        );
        const row = r.rows[0];
        if (!row) continue; // already filed — treat as synced, don't re-broadcast
        inserted.push(row.id);
        insertedPayloads.push({
          id: row.id,
          type: h.type,
          lat: h.lat,
          lng: h.lng,
          status: 'active',
          expiresAt: expires.toISOString(),
          confirmationCount: 0,
          dismissalCount: 0,
          createdAt: created.toISOString(),
        });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Broadcast each synced report exactly like the live POST /hazards path
    // (Req 11.2, 11.10) — previously offline-queued hazards were inserted
    // silently, so other users' maps never showed them until their next
    // GET /hazards backfill (app restart / socket reconnect). Skip reports
    // that expired before the sync completed — broadcasting an already-dead
    // hazard would paint a pin the server won't return from GET /hazards.
    const nowAfterCommit = Date.now();
    for (const payload of insertedPayloads) {
      if (new Date(payload.expiresAt).getTime() <= nowAfterCommit) continue;
      fastify.io.emit('hazard:new', payload);
    }

    // Reports recognised as replays cost the reporter nothing — they were
    // already charged to the quota when they first landed.
    const duplicates = accepted.length - inserted.length;
    if (duplicates > 0) await redis.decrby(rateKey, duplicates);

    // `accepted` is how many of the SUBMITTED items are now settled (inserted
    // or already present) — the client clears that many from the head of the
    // batch it sent. `deferred` is what it must keep for the next window.
    return reply.code(201).send({
      inserted,
      count: inserted.length,
      accepted: accepted.length,
      deferred,
    });
  });

  // POST /hazards/:id/confirm — confirm a report (Req 11.5)
  fastify.post('/hazards/:id/confirm', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };

    // Verify hazard exists and is active before recording vote
    const hazardCheck = await pool.query(
      `SELECT 1 FROM hazard_reports WHERE id = $1 AND status = 'active' AND expires_at > now()`,
      [id],
    );
    if ((hazardCheck.rowCount ?? 0) === 0) {
      return reply.notFound('Hazard not found or already resolved');
    }

    // Insert vote — catch unique constraint to handle concurrent requests safely
    try {
      await pool.query(
        `INSERT INTO hazard_votes (hazard_id, user_id, vote) VALUES ($1, $2, 'confirm')`,
        [id, userId],
      );
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        return reply.conflict('Already voted on this hazard');
      }
      throw err;
    }

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
  fastify.post('/hazards/:id/dismiss', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };

    // Verify hazard exists and is active before recording vote
    const hazardCheck2 = await pool.query(
      `SELECT 1 FROM hazard_reports WHERE id = $1 AND status = 'active' AND expires_at > now()`,
      [id],
    );
    if ((hazardCheck2.rowCount ?? 0) === 0) {
      return reply.notFound('Hazard not found or already resolved');
    }

    try {
      await pool.query(
        `INSERT INTO hazard_votes (hazard_id, user_id, vote) VALUES ($1, $2, 'dismiss')`,
        [id, userId],
      );
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        return reply.conflict('Already voted on this hazard');
      }
      throw err;
    }

    // Atomically increment and update status when threshold reached (Req 11.6)
    const result = await pool.query<{ id: string; dismissal_count: number; status: string }>(
      `UPDATE hazard_reports
       SET dismissal_count = dismissal_count + 1,
           status = CASE WHEN dismissal_count + 1 >= 3 THEN 'dismissed' ELSE status END,
           expires_at = CASE WHEN dismissal_count + 1 >= 3 THEN now() ELSE expires_at END,
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

