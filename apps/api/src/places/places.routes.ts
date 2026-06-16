import { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/authenticate';

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
      // Nearby amenities search — use tight bounding box, bounded=1
      url.searchParams.set('q', 'amenities');
      url.searchParams.set('limit', '15');
      url.searchParams.set('bounded', '1');
    } else {
      // Normal text search
      url.searchParams.set('q', q);
      url.searchParams.set('limit', '10');
    }

    if (hasLocation) {
      // ~50km bounding box: (lng-0.5),(lat+0.5),(lng+0.5),(lat-0.5)
      const viewbox = `${lng! - 0.5},${lat! + 0.5},${lng! + 0.5},${lat! - 0.5}`;
      url.searchParams.set('viewbox', viewbox);
      if (!isNearbySearch) {
        url.searchParams.set('bounded', '0');
      }
    }

    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'ConvoyApp/1.0 (testing)' },
      signal: AbortSignal.timeout(8000),
    });

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
}
