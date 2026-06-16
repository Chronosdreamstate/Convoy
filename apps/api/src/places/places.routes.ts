import { FastifyInstance } from 'fastify';

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
  app.get<{ Querystring: { q?: string } }>('/places/search', async (req, reply) => {
    const q = req.query.q?.trim() ?? '';
    if (q.length < 3) return reply.send([]);

    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', q);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '10');
    url.searchParams.set('addressdetails', '1');

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
