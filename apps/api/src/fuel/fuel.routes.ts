/**
 * Fuel stop suggestions API
 * Requirements: 21.1–21.5
 */

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';
import { env } from '../config/env';

const createFuelLogSchema = z.object({
  gallons: z.number().positive().max(1000),
  pricePerGallon: z.number().positive().max(100),
  notes: z.string().max(500).optional(),
  location: z.string().max(200).optional(),
  // odometerKm: the reading at this fill-up, in km (canonical metric unit —
  // matches the app's internal-metric / display-converted-by-distanceUnit
  // pattern). Used server-side to compute `mpg` from the delta against the
  // user's previous fuel log; not required (first-ever entry has nothing to
  // diff against, and users may skip it).
  odometerKm: z.number().positive().max(9_999_999).optional(),
  // Not `.datetime()` — the original behavior accepts any string `new Date()` can parse
  // (e.g. plain "2024-01-01"), not strictly full ISO-8601 with time. Just cap length so
  // an absurdly long string can't be thrown at the date parser.
  date: z.string().max(50).optional(),
});

const KM_PER_MILE = 1.609344;

/**
 * Server-side MPG computation — deliberately ignores any client-supplied mpg
 * so the value is consistent regardless of client. Computes
 * (distance since previous fill-up, converted to miles) / gallons used at
 * this fill-up. Returns null when there's no previous entry, either entry is
 * missing an odometer reading, or the odometer didn't increase (bad data /
 * out-of-order entry) — never divides by a non-positive distance.
 */
export function computeMpg(
  currentOdometerKm: number | null | undefined,
  previousOdometerKm: number | null | undefined,
  gallons: number,
): number | null {
  if (currentOdometerKm == null || previousOdometerKm == null) return null;
  const distanceKm = currentOdometerKm - previousOdometerKm;
  if (distanceKm <= 0) return null;
  const distanceMiles = distanceKm / KM_PER_MILE;
  return Math.round((distanceMiles / gallons) * 100) / 100;
}

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

interface NominatimPoiResult {
  place_id: number;
  display_name: string;
  name?: string;
  lat: string;
  lon: string;
}

// ---------------------------------------------------------------------------
// Nominatim (OpenStreetMap) POI search — fuel stations near a point.
//
// This previously proxied Mapbox's classic Geocoding API (`mapbox.places`)
// with `types=poi`, but that endpoint is address/place-name search, not a POI
// category search — it returns zero results for keyword queries like "fuel"
// or brand names ("shell") even in dense urban areas, so the fuel-stop
// suggestion feature could never actually find a station. `places.routes.ts`
// already uses Nominatim for the same kind of nearby-POI lookup (destination
// search's "fuel station restaurant" fallback) and it does return real
// results, so this mirrors that working approach.
// ---------------------------------------------------------------------------

async function searchFuelStations(
  lat: number,
  lng: number,
  radiusM: number,
  contactEmail: string,
): Promise<FuelStation[]> {
  const radiusDeg = radiusM / 111_320; // rough metres → degrees for the bounding viewbox
  const minLng = Math.max(-180, lng - radiusDeg);
  const maxLng = Math.min(180, lng + radiusDeg);
  const maxLat = Math.min(90, lat + radiusDeg);
  const minLat = Math.max(-90, lat - radiusDeg);

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('format', 'json');
  url.searchParams.set('q', 'fuel station');
  url.searchParams.set('limit', String(MAX_FUEL_RESULTS));
  url.searchParams.set('bounded', '1');
  url.searchParams.set('viewbox', `${minLng},${maxLat},${maxLng},${minLat}`);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { 'User-Agent': `ConvoyApp/1.0 (${contactEmail})` },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const data = (await res.json()) as NominatimPoiResult[];

  const stations: FuelStation[] = [];
  for (const item of data) {
    const fLat = parseFloat(item.lat);
    const fLng = parseFloat(item.lon);
    if (isNaN(fLat) || isNaN(fLng)) continue;
    const dx = (fLng - lng) * 111_320 * Math.cos((lat * Math.PI) / 180);
    const dy = (fLat - lat) * 110_574;
    const distanceM = Math.sqrt(dx * dx + dy * dy);
    if (distanceM <= radiusM) {
      const parts = item.display_name.split(',');
      stations.push({
        id: String(item.place_id),
        name: item.name ?? parts[0]?.trim() ?? item.display_name,
        address: item.display_name,
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
      notes: string | null; location: string | null; mpg: string | null; odometer_km: string | null;
    }>(
      `SELECT id, date, gallons, price_per_gallon, notes, location, mpg, odometer_km
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
        odometerKm: r.odometer_km != null ? parseFloat(r.odometer_km) : undefined,
      })),
    });
  });

  // ── POST /fuel/logs ───────────────────────────────────────────────────────
  fastify.post('/fuel/logs', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const parsed = createFuelLogSchema.safeParse(request.body);
    if (!parsed.success) return reply.badRequest(parsed.error.errors[0].message);
    const body = parsed.data;
    const gallons = body.gallons;
    const ppg = body.pricePerGallon;
    const odometerKm = body.odometerKm ?? null;
    const date = body.date ? new Date(body.date) : new Date();
    if (isNaN(date.getTime())) return reply.badRequest('invalid date');

    // Find the user's previous fuel log entry (most recent strictly before
    // this one's date) to diff odometer readings against. First-ever entry
    // (or one with no prior odometer reading) legitimately has nothing to
    // diff against — computeMpg returns null in that case.
    const prevResult = await fastify.db.query<{ odometer_km: string | null }>(
      `SELECT odometer_km FROM fuel_logs WHERE user_id = $1 AND date < $2
       ORDER BY date DESC, created_at DESC LIMIT 1`,
      [userId, date],
    );
    const prevOdometerKm = prevResult.rows[0]?.odometer_km != null
      ? parseFloat(prevResult.rows[0].odometer_km)
      : null;
    const mpg = computeMpg(odometerKm, prevOdometerKm, gallons);

    const result = await fastify.db.query<{ id: string; date: Date; gallons: string; price_per_gallon: string; notes: string | null; location: string | null; mpg: string | null; odometer_km: string | null }>(
      `INSERT INTO fuel_logs (user_id, date, gallons, price_per_gallon, notes, location, mpg, odometer_km)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, date, gallons, price_per_gallon, notes, location, mpg, odometer_km`,
      [userId, date, gallons, ppg, body.notes ?? null, body.location ?? null, mpg, odometerKm],
    );
    const r = result.rows[0];
    return reply.status(201).send({
      id: r.id, date: r.date.toISOString(),
      gallons: parseFloat(r.gallons), pricePerGallon: parseFloat(r.price_per_gallon),
      notes: r.notes ?? undefined, location: r.location ?? undefined,
      mpg: r.mpg != null ? parseFloat(r.mpg) : undefined,
      odometerKm: r.odometer_km != null ? parseFloat(r.odometer_km) : undefined,
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

    const stations = await searchFuelStations(lat, lng, FUEL_SEARCH_RADIUS_M, env.NOMINATIM_CONTACT_EMAIL);

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

