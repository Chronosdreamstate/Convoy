import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
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

export interface Route {
  distance: number;  // metres
  duration: number;  // seconds
  distanceText: string;
  durationText: string;
  geometry: RouteGeometry;
}

interface MapboxRoute {
  distance: number;
  duration: number;
  geometry: RouteGeometry;
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
  fastify.post('/routes/calculate', { preHandler: [authenticate] }, async (request, reply) => {
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
      overview: 'simplified',
      steps: 'false',
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
  fastify.post('/groups/:id/route', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id: groupId } = request.params as { id: string };

    const parsed = pushRouteSchema.safeParse(request.body);
    if (!parsed.success) return reply.badRequest(parsed.error.errors[0].message);

    // Verify caller is the group admin
    const groupResult = await fastify.db.query<{ admin_id: string; status: string }>(
      'SELECT admin_id, status FROM convoy_groups WHERE id = $1',
      [groupId],
    );
    const group = groupResult.rows[0];
    if (!group) return reply.notFound('Group not found');
    if (group.status !== 'active') return reply.gone('Group is not active');
    if (group.admin_id !== userId) return reply.forbidden('Only the Admin can push a route');

    // Emit route:pushed to all members in the group room
    fastify.io.to(`group:${groupId}`).emit('route:pushed', {
      pushedBy: userId,
      route: parsed.data.route,
    });

    return reply.status(200).send({ message: 'Route pushed to group' });
  });
}

export default routesRoutes;
