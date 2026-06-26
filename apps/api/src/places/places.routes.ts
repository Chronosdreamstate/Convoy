import { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';
import { env } from '../config/env';

interface NominatimResult {
  place_id: number;
  display_name: string;
  name?: string;
  lat: string;
  lon: string;
  type?: string;
  class?: string;
  address?: {
    road?: string;
    city?: string;
    town?: string;
    state?: string;
    country?: string;
  };
}

const MAX_RECENT_PLACES = 20;

export default async function placesRoutes(app: FastifyInstance) {
  // GET /places/recent — fetch user's server-synced recent destinations (newest first)
  app.get('/places/recent', { preHandler: [authenticate, generalLimiter(app.redis)] }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const { rows } = await app.db.query<{
      id: string; place_id: string | null; name: string; address: string;
      lat: number; lng: number; visited_at: string;
    }>(
      `SELECT id, place_id, name, address, lat, lng, visited_at
         FROM user_recent_places
        WHERE user_id = $1
        ORDER BY visited_at DESC
        LIMIT $2`,
      [userId, MAX_RECENT_PLACES],
    );
    return reply.send(rows.map((r) => ({
      id: r.id,
      placeId: r.place_id,
      name: r.name,
      address: r.address,
      lat: Number(r.lat),
      lng: Number(r.lng),
      visitedAt: r.visited_at,
    })));
  });

  // POST /places/recent — upsert a destination into the user's recent list
  app.post<{
    Body: { placeId?: string; name: string; address?: string; lat: number; lng: number };
  }>('/places/recent', { preHandler: [authenticate, generalLimiter(app.redis)] }, async (req, reply) => {
    const userId = (req.user as { sub: string }).sub;
    const { placeId, name, address = '', lat, lng } = req.body;

    if (!name || typeof lat !== 'number' || typeof lng !== 'number') {
      return reply.status(400).send({ error: 'name, lat, and lng are required' });
    }

    await app.db.query(
      `INSERT INTO user_recent_places (user_id, place_id, name, address, lat, lng, visited_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (user_id, name, address)
       DO UPDATE SET place_id = EXCLUDED.place_id, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
                     visited_at = now()`,
      [userId, placeId ?? null, name.trim(), address.trim(), lat, lng],
    );

    // Prune oldest beyond cap
    await app.db.query(
      `DELETE FROM user_recent_places
        WHERE user_id = $1
          AND id NOT IN (
            SELECT id FROM user_recent_places
             WHERE user_id = $1
             ORDER BY visited_at DESC
             LIMIT $2
          )`,
      [userId, MAX_RECENT_PLACES],
    );

    return reply.status(204).send();
  });

  app.get<{ Querystring: { q?: string; lat?: string; lng?: string; limit?: string } }>('/places/search', { preHandler: [authenticate, generalLimiter(app.redis)] }, async (req, reply) => {
    const q = req.query.q?.trim() ?? '';
    const lat = req.query.lat !== undefined ? parseFloat(req.query.lat) : null;
    const lng = req.query.lng !== undefined ? parseFloat(req.query.lng) : null;
    const clientLimit = req.query.limit !== undefined
      ? Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 10))
      : null;
    const hasLocation = lat !== null && lng !== null && !isNaN(lat) && !isNaN(lng);
    const isNearbySearch = hasLocation && q.length < 3;

    // When no location provided and query is too short, return empty
    if (!hasLocation && q.length < 3) return reply.send([]);

    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('format', 'json');
    url.searchParams.set('addressdetails', '1');

    if (isNearbySearch) {
      // Nearby search — use the user's query or fall back to useful POI types
      url.searchParams.set('q', q || 'fuel station restaurant');
      url.searchParams.set('limit', String(clientLimit ?? 15));
      url.searchParams.set('bounded', '1');
    } else {
      // Normal text search
      url.searchParams.set('q', q);
      url.searchParams.set('limit', String(clientLimit ?? 10));
    }

    if (hasLocation) {
      // ~50km bounding box: (lng-0.5),(lat+0.5),(lng+0.5),(lat-0.5) — clamped to valid ranges
      const minLng = Math.max(-180, lng! - 0.5);
      const maxLng = Math.min(180, lng! + 0.5);
      const maxLat = Math.min(90, lat! + 0.5);
      const minLat = Math.max(-90, lat! - 0.5);
      const viewbox = `${minLng},${maxLat},${maxLng},${minLat}`;
      url.searchParams.set('viewbox', viewbox);
      if (!isNearbySearch) {
        url.searchParams.set('bounded', '0');
      }
    }

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { 'User-Agent': `ConvoyApp/1.0 (${env.NOMINATIM_CONTACT_EMAIL})` },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      return reply.send([]);
    }

    if (!res.ok) return reply.send([]);

    const data = (await res.json()) as NominatimResult[];

    const results = data.map((item) => {
      const parts = item.display_name.split(',');
      const name = item.name ?? parts[0]?.trim() ?? item.display_name;
      const address = parts.slice(1).join(',').trim();
      return {
        id: String(item.place_id),
        name,
        address: address || item.display_name,
        category: item.type ?? item.class ?? null,
        lat: parseFloat(item.lat),
        lng: parseFloat(item.lon),
      };
    });

    return reply.send(results);
  });

  // GET /places/reverse?lat=X&lng=Y — reverse-geocode for pin drop callout (Req 5.2)
  app.get<{ Querystring: { lat?: string; lng?: string } }>('/places/reverse', { preHandler: [authenticate, generalLimiter(app.redis)] }, async (req, reply) => {
    const lat = parseFloat(req.query.lat ?? '');
    const lng = parseFloat(req.query.lng ?? '');
    if (isNaN(lat) || isNaN(lng)) return reply.status(400).send({ error: 'lat and lng are required' });

    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&addressdetails=1`;
      const res = await fetch(url, {
        headers: { 'User-Agent': `ConvoyApp/1.0 (${env.NOMINATIM_CONTACT_EMAIL})` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return reply.send({ address: null });
      const data = (await res.json()) as { display_name?: string };
      return reply.send({ address: data.display_name ?? null });
    } catch {
      return reply.send({ address: null });
    }
  });
}

