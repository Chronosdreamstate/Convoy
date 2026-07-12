import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';
import { env } from '../config/env';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RouteGeometry {
  type: 'LineString';
  coordinates: [number, number][];
}

/**
 * Traffic congestion level for one route segment, as reported by the Mapbox
 * Directions `congestion` annotation (Req 6.2 four-tier coloring:
 * low→green, moderate→yellow, heavy→red, severe→dark-red).
 */
export type CongestionLevel = 'low' | 'moderate' | 'heavy' | 'severe' | 'unknown';

export interface Route {
  distance: number;  // metres
  duration: number;  // seconds
  distanceText: string;
  durationText: string;
  geometry: RouteGeometry;
  speedLimitKph: number | null;
  /**
   * Per-segment posted speed limit (kph), one entry per coordinate-to-coordinate
   * segment in `geometry.coordinates` (concatenated across legs). Lets the client
   * look up the limit for the segment nearest the driver's current position as
   * they advance along the route, rather than a single route-wide summary
   * (Req 23.1, 23.2).
   */
  speedLimitSegmentsKph: (number | null)[];
  /**
   * Per-segment traffic congestion level, aligned exactly like
   * `speedLimitSegmentsKph`: entry i describes the segment between
   * `geometry.coordinates[i]` and `geometry.coordinates[i + 1]` (concatenated
   * across legs). Drives the four-tier route-line color coding (Req 6.2).
   * Empty when Mapbox supplied no congestion annotation.
   */
  congestionSegments: CongestionLevel[];
}

interface MapboxMaxspeedEntry {
  speed?: number;
  unit?: string;
  unknown?: boolean;
  none?: boolean;
}

interface MapboxLeg {
  annotation?: { maxspeed?: MapboxMaxspeedEntry[]; congestion?: string[] };
}

interface MapboxRoute {
  distance: number;
  duration: number;
  geometry: RouteGeometry;
  legs?: MapboxLeg[];
}

interface MapboxDirectionsResponse {
  routes?: MapboxRoute[];
  code: string;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for property testing
// ---------------------------------------------------------------------------

export function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

export function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * Extract the modal posted speed limit (kph) from a Mapbox legs annotation.
 * Returns null if Mapbox reports all segments as unknown.
 */
export function extractSpeedLimitKph(legs?: MapboxLeg[]): number | null {
  if (!legs?.length) return null;
  const allSpeeds: number[] = [];
  for (const leg of legs) {
    for (const entry of (leg.annotation?.maxspeed ?? [])) {
      if (entry.speed == null || entry.unknown || entry.none) continue;
      const kph = entry.unit === 'mph' ? Math.round(entry.speed * 1.60934) : entry.speed;
      allSpeeds.push(kph);
    }
  }
  if (!allSpeeds.length) return null;
  const counts = new Map<number, number>();
  let maxCount = 0;
  let modal = allSpeeds[0];
  for (const s of allSpeeds) {
    const c = (counts.get(s) ?? 0) + 1;
    counts.set(s, c);
    if (c > maxCount) { maxCount = c; modal = s; }
  }
  return modal;
}

/**
 * Convert a single Mapbox maxspeed annotation entry to kph, or null when
 * the segment's limit is unknown/unposted.
 */
function maxspeedEntryToKph(entry: MapboxMaxspeedEntry): number | null {
  if (entry.speed == null || entry.unknown || entry.none) return null;
  return entry.unit === 'mph' ? Math.round(entry.speed * 1.60934) : entry.speed;
}

/**
 * Per-segment posted speed limit (kph), aligned to the coordinate segments of
 * the merged route geometry (one entry per leg-segment, concatenated in leg
 * order). Req 23.1, 23.2 — lets the client show the limit for whichever
 * segment the driver currently occupies instead of one route-wide value.
 */
export function extractSpeedLimitSegmentsKph(legs?: MapboxLeg[]): (number | null)[] {
  if (!legs?.length) return [];
  const segments: (number | null)[] = [];
  for (const leg of legs) {
    for (const entry of (leg.annotation?.maxspeed ?? [])) {
      segments.push(maxspeedEntryToKph(entry));
    }
  }
  return segments;
}

const CONGESTION_LEVELS: ReadonlySet<string> = new Set(['low', 'moderate', 'heavy', 'severe', 'unknown']);

/**
 * Per-segment traffic congestion level, aligned to the coordinate segments of
 * the merged route geometry exactly like `extractSpeedLimitSegmentsKph` (one
 * entry per leg-segment, concatenated in leg order). Req 6.2 — feeds the
 * client's four-tier route-line color coding. Unrecognised values from Mapbox
 * are normalised to 'unknown'; a missing annotation yields an empty array.
 */
export function extractCongestionSegments(legs?: MapboxLeg[]): CongestionLevel[] {
  if (!legs?.length) return [];
  const segments: CongestionLevel[] = [];
  for (const leg of legs) {
    for (const level of (leg.annotation?.congestion ?? [])) {
      segments.push(CONGESTION_LEVELS.has(level) ? (level as CongestionLevel) : 'unknown');
    }
  }
  return segments;
}

/**
 * Cap Mapbox alternatives at 3 and normalise to Route shape.
 * Exported for Property 6 testing.
 */
export function processMapboxRoutes(routes: MapboxRoute[]): Route[] {
  return (routes ?? []).slice(0, 3).map((r) => ({
    distance: r.distance,
    duration: r.duration,
    distanceText: formatDistance(r.distance),
    durationText: formatDuration(r.duration),
    geometry: r.geometry,
    speedLimitKph: extractSpeedLimitKph(r.legs),
    speedLimitSegmentsKph: extractSpeedLimitSegmentsKph(r.legs),
    congestionSegments: extractCongestionSegments(r.legs),
  }));
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const latLngSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

const calculateRouteSchema = z.object({
  origin: latLngSchema,
  destination: latLngSchema,
  waypoints: z.array(latLngSchema).max(10).optional().default([]),
  scenic: z.boolean().optional().default(false),
});

const pushRouteSchema = z.object({
  route: z.object({
    distance: z.number(),
    duration: z.number(),
    distanceText: z.string(),
    durationText: z.string(),
    geometry: z.object({
      type: z.literal('LineString'),
      coordinates: z.array(z.tuple([z.number(), z.number()])),
    }),
    // Without these, zod's default object parsing strips them from the
    // broadcast payload, leaving every group member's Speed Limit HUD showing
    // "–" for a pushed route even when Mapbox supplied real data (Req 23.1).
    speedLimitKph: z.number().nullable().optional(),
    speedLimitSegmentsKph: z.array(z.number().nullable()).optional(),
    // Same stripping hazard as above: without this, congestion data would be
    // dropped from the route:pushed broadcast and pushed routes would render
    // without traffic color coding on members' maps (Req 6.2).
    congestionSegments: z.array(z.enum(['low', 'moderate', 'heavy', 'severe', 'unknown'])).optional(),
  }),
});

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

async function routesRoutes(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {

  // -------------------------------------------------------------------------
  // POST /routes/calculate — proxy to Mapbox Directions API (Req 6.1)
  // -------------------------------------------------------------------------
  fastify.post('/routes/calculate', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const parsed = calculateRouteSchema.safeParse(request.body);
    if (!parsed.success) return reply.badRequest(parsed.error.errors[0].message);

    const { origin, destination, waypoints, scenic } = parsed.data;

    // Build coordinate string: origin → waypoints → destination (Mapbox format: lng,lat)
    const coords = [origin, ...waypoints, destination]
      .map((p) => `${p.lng},${p.lat}`)
      .join(';');

    const params = new URLSearchParams({
      alternatives: 'true',
      geometries: 'geojson',
      // Mapbox requires overview=full whenever annotations are requested — 'simplified'
      // (or 'false') combined with annotations=maxspeed is rejected with a 422
      // InvalidInput error ("Overview option must be full for maxspeed"), which made
      // every /routes/calculate call fail.
      overview: 'full',
      steps: 'false',
      // Req 23: maxspeed populates the speed limit HUD; Req 6.2: congestion
      // drives the four-tier route-line color coding.
      annotations: 'maxspeed,congestion',
      access_token: env.MAPBOX_API_TOKEN,
    });

    // Scenic routing: avoid motorways (Req 22.1)
    if (scenic) params.set('exclude', 'motorway');

    const url = `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coords}?${params}`;

    let mapboxData: MapboxDirectionsResponse;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        fastify.log.error({ status: res.status }, 'Mapbox Directions API error');
        return reply.internalServerError('Route calculation failed');
      }
      mapboxData = (await res.json()) as MapboxDirectionsResponse;
    } catch (err) {
      fastify.log.error(err, 'Mapbox fetch failed');
      return reply.internalServerError('Route calculation failed');
    }

    if (!mapboxData.routes?.length) {
      return reply.notFound('No routes found between those coordinates');
    }

    const routes = processMapboxRoutes(mapboxData.routes);
    return reply.send({ routes });
  });

  // -------------------------------------------------------------------------
  // POST /groups/:id/route — Admin pushes selected route to group (Req 9.1–9.3)
  // -------------------------------------------------------------------------
  fastify.post('/groups/:id/route', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id: groupId } = request.params as { id: string };

    const parsed = pushRouteSchema.safeParse(request.body);
    if (!parsed.success) return reply.badRequest(parsed.error.errors[0].message);

    // Verify caller is an active member of the group
    const memberResult = await fastify.db.query<{ id: string }>(
      'SELECT id FROM convoy_members WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL',
      [groupId, userId],
    );
    if (!memberResult.rows[0]) return reply.forbidden('You are not a member of this group');

    // Verify caller is the group admin
    const groupResult = await fastify.db.query<{ admin_id: string; status: string }>(
      'SELECT admin_id, status FROM convoy_groups WHERE id = $1',
      [groupId],
    );
    const group = groupResult.rows[0];
    if (!group) return reply.notFound('Group not found');
    if (group.status !== 'active') return reply.gone('Group is not active');
    if (group.admin_id !== userId) return reply.forbidden('Only the Admin can push a route');

    // Store destination for arrival detection (Req 15.3)
    const coords = parsed.data.route.geometry.coordinates;
    const lastCoord = coords[coords.length - 1];
    if (lastCoord) {
      await fastify.redis.hset(`route:${groupId}:dest`, {
        lat: String(lastCoord[1]),  // GeoJSON coords are [lng, lat]
        lng: String(lastCoord[0]),
      });
      await fastify.redis.expire(`route:${groupId}:dest`, 24 * 60 * 60);
      // Clear per-user "already notified" flags so everyone can receive the new arrival alert
      const memberRows = await fastify.db.query<{ user_id: string }>(
        'SELECT user_id FROM convoy_members WHERE group_id = $1 AND left_at IS NULL',
        [groupId],
      );
      const delKeys = memberRows.rows.map((r) => `arrived:${groupId}:${r.user_id}`);
      if (delKeys.length) await fastify.redis.del(...delKeys);
    }

    // Emit route:pushed to all members in the group room
    fastify.io.to(`group:${groupId}`).emit('route:pushed', {
      pushedBy: userId,
      route: parsed.data.route,
    });

    return reply.status(200).send({ message: 'Route pushed to group' });
  });
}

export default routesRoutes;

