import { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/authenticate';
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

export default async function placesRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string; lat?: string; lng?: string } }>('/places/search', { preHandler: [authenticate] }, async (req, reply) => {
    const q = req.query.q?.trim() ?? '';
    const lat = req.query.lat !== undefined ? parseFloat(req.query.lat) : null;
    const lng = req.query.lng !== undefined ? parseFloat(req.query.lng) : null;
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
      url.searchParams.set('limit', '15');
      url.searchParams.set('bounded', '1');
    } else {
      // Normal text search
      url.searchParams.set('q', q);
      url.searchParams.set('limit', '10');
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
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        return reply.send([]);
      }
      throw err;
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
  app.get<{ Querystring: { lat?: string; lng?: string } }>('/places/reverse', { preHandler: [authenticate] }, async (req, reply) => {
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
