/**
 * Fuel stop suggestions API
 * Requirements: 21.1–21.5
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';
import { env } from '../config/env';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FUEL_DISTANCE_THRESHOLD_M = 150 * 1609.34; // 150 miles → metres
export const FUEL_TIME_THRESHOLD_S = 2 * 3600;          // 2 hours → seconds
export const FUEL_SEARCH_RADIUS_M = 10 * 1609.34;       // 10 miles → metres
export const MAX_FUEL_RESULTS = 10;

// ---------------------------------------------------------------------------
// Pure helpers — exported for property testing
// ---------------------------------------------------------------------------

export interface SessionProgress {
  distanceM: number;
  durationS: number;
}

/** Property 35: suggestion fires the first time either threshold is reached. */
export function shouldSuggestFuel(progress: SessionProgress): boolean {
  return (
    progress.distanceM >= FUEL_DISTANCE_THRESHOLD_M ||
    progress.durationS >= FUEL_TIME_THRESHOLD_S
  );
}

export interface FuelStation {
  id: string;
  name: string;
  distanceM: number;
  lat: number;
  lng: number;
  address: string;
}

// ---------------------------------------------------------------------------
// Mapbox Places API proxy — fuel stations near a point
// ---------------------------------------------------------------------------

async function searchFuelStations(
  lat: number,
  lng: number,
  radiusM: number,
  accessToken: string,
): Promise<FuelStation[]> {
  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/fuel.json` +
    `?proximity=${lng},${lat}&limit=${MAX_FUEL_RESULTS}&types=poi` +
    `&bbox=${lng - 0.15},${lat - 0.15},${lng + 0.15},${lat + 0.15}` +
    `&access_token=${accessToken}`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const data = (await res.json()) as {
    features: Array<{
      id: string;
      text: string;
      place_name: string;
      center: [number, number];
      properties: Record<string, unknown>;
    }>;
  };

  const stations: FuelStation[] = [];
  for (const f of data.features) {
    const [fLng, fLat] = f.center;
    const dx = (fLng - lng) * 111_320 * Math.cos((lat * Math.PI) / 180);
    const dy = (fLat - lat) * 110_574;
    const distanceM = Math.sqrt(dx * dx + dy * dy);
    if (distanceM <= radiusM) {
      stations.push({
        id: f.id,
        name: f.text,
        address: f.place_name,
        lat: fLat,
        lng: fLng,
        distanceM: Math.round(distanceM),
      });
    }
  }

  return stations.sort((a, b) => a.distanceM - b.distanceM);
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

const fuelRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET /fuel/logs ────────────────────────────────────────────────────────
  fastify.get('/fuel/logs', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const result = await fastify.db.query<{
      id: string; date: Date; gallons: string; price_per_gallon: string;
      notes: string | null; location: string | null; mpg: string | null;
    }>(
      `SELECT id, date, gallons, price_per_gallon, notes, location, mpg
       FROM fuel_logs WHERE user_id = $1 ORDER BY date DESC LIMIT 200`,
      [userId],
    );
    return reply.send({
      logs: result.rows.map((r) => ({
        id: r.id,
        date: r.date.toISOString(),
        gallons: parseFloat(r.gallons),
        pricePerGallon: parseFloat(r.price_per_gallon),
        notes: r.notes ?? undefined,
        location: r.location ?? undefined,
        mpg: r.mpg != null ? parseFloat(r.mpg) : undefined,
      })),
    });
  });

  // ── POST /fuel/logs ───────────────────────────────────────────────────────
  fastify.post('/fuel/logs', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const body = request.body as {
      gallons?: number; pricePerGallon?: number;
      notes?: string; location?: string; mpg?: number; date?: string;
    };
    const gallons = Number(body.gallons);
    const ppg = Number(body.pricePerGallon);
    if (!gallons || gallons <= 0) return reply.badRequest('gallons must be > 0');
    if (!ppg || ppg <= 0) return reply.badRequest('pricePerGallon must be > 0');
    const date = body.date ? new Date(body.date) : new Date();
    if (isNaN(date.getTime())) return reply.badRequest('invalid date');

    const result = await fastify.db.query<{ id: string; date: Date; gallons: string; price_per_gallon: string; notes: string | null; location: string | null; mpg: string | null }>(
      `INSERT INTO fuel_logs (user_id, date, gallons, price_per_gallon, notes, location, mpg)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, date, gallons, price_per_gallon, notes, location, mpg`,
      [userId, date, gallons, ppg, body.notes ?? null, body.location ?? null, body.mpg ?? null],
    );
    const r = result.rows[0];
    return reply.status(201).send({
      id: r.id, date: r.date.toISOString(),
      gallons: parseFloat(r.gallons), pricePerGallon: parseFloat(r.price_per_gallon),
      notes: r.notes ?? undefined, location: r.location ?? undefined,
      mpg: r.mpg != null ? parseFloat(r.mpg) : undefined,
    });
  });

  // ── DELETE /fuel/logs/:id ─────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>('/fuel/logs/:id', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const result = await fastify.db.query(
      `DELETE FROM fuel_logs WHERE id = $1 AND user_id = $2`,
      [request.params.id, userId],
    );
    if ((result.rowCount ?? 0) === 0) return reply.notFound('Fuel log not found');
    return reply.status(204).send();
  });

  // ── GET /places/fuel ─────────────────────────────────────────────────────
  // Property 36: accessible to all Members (Req 21.4)
  fastify.get('/places/fuel', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {

    const q = request.query as { lat?: string; lng?: string };
    const lat = parseFloat(q.lat ?? '');
    const lng = parseFloat(q.lng ?? '');

    if (isNaN(lat) || isNaN(lng)) {
      return reply.status(400).send({ error: 'lat and lng are required' });
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return reply.status(400).send({ error: 'lat must be -90 to 90 and lng must be -180 to 180' });
    }

    const stations = await searchFuelStations(lat, lng, FUEL_SEARCH_RADIUS_M, env.MAPBOX_API_TOKEN);

    if (stations.length === 0) {
      return reply.send({ stations: [], message: 'No fuel stations found nearby' });
    }

    return reply.send({ stations });
  });

  // ── GET /groups/:id/fuel/status ───────────────────────────────────────────
  // Returns whether the group has reached a fuel suggestion threshold (Req 21.1)
  fastify.get<{ Params: { id: string } }>(
    '/groups/:id/fuel/status',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const groupId = request.params.id;

      // Verify membership
      const memberResult = await fastify.db.query<{ id: string }>(
        `SELECT id FROM convoy_members WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL`,
        [groupId, userId],
      );
      if (memberResult.rows.length === 0) {
        return reply.status(403).send({ error: 'Not an active group member' });
      }

      // Read accumulated stats from Redis
      const distanceKey = `group:${groupId}:distance_m`;
      const startKey = `group:${groupId}:started_at`;

      const [rawDistance, rawStartedAt] = await Promise.all([
        fastify.redis.get(distanceKey),
        fastify.redis.get(startKey),
      ]);

      const distanceM = rawDistance ? parseFloat(rawDistance) : 0;

      let startedAtMs: number | null = rawStartedAt ? parseInt(rawStartedAt, 10) : null;
      if (startedAtMs === null) {
        // Redis TTL may have expired — fall back to DB for active groups
        const groupRow = await fastify.db.query<{ created_at: Date }>(
          `SELECT created_at FROM convoy_groups WHERE id = $1 AND status = 'active'`,
          [groupId],
        );
        if (groupRow.rows[0]) {
          startedAtMs = groupRow.rows[0].created_at.getTime();
        }
      }
      const durationS = startedAtMs !== null
        ? Math.floor((Date.now() - startedAtMs) / 1000)
        : 0;

      const suggest = shouldSuggestFuel({ distanceM, durationS });

      return reply.send({ suggest, distanceM, durationS });
    },
  );
};

export default fuelRoutes;

