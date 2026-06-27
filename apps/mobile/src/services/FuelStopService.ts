/**
 * FuelStopService — fetches nearby fuel stations via the free Overpass API
 * (OpenStreetMap data, no API key required).
 *
 * Requirements: fetch, cache (5 min), sort by distance ASC.
 */

export interface FuelStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  distanceM: number;
}

// ---------------------------------------------------------------------------
// Haversine distance (inline — no external import)
// ---------------------------------------------------------------------------

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000; // Earth radius in metres
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  stations: FuelStation[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes
const COORD_PRECISION = 3; // round lat/lon to 3 d.p. for cache key

function cacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(COORD_PRECISION)},${lon.toFixed(COORD_PRECISION)}`;
}

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

class FuelStopServiceImpl {
  private readonly cache = new Map<string, CacheEntry>();

  async fetchNearbyFuel(
    lat: number,
    lon: number,
    radiusM = 5000,
  ): Promise<FuelStation[]> {
    const key = cacheKey(lat, lon);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.stations;
    }

    const query = `[out:json]; node[amenity=fuel](around:${radiusM},${lat},${lon}); out 10;`;
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Overpass API error: ${response.status}`);
    }

    const json = (await response.json()) as {
      elements: Array<{
        id: number;
        lat: number;
        lon: number;
        tags?: { name?: string };
      }>;
    };

    const stations: FuelStation[] = (json.elements ?? []).map((node) => ({
      id: String(node.id),
      name: node.tags?.name ?? 'Fuel Station',
      lat: node.lat,
      lon: node.lon,
      distanceM: Math.round(haversineM(lat, lon, node.lat, node.lon)),
    }));

    stations.sort((a, b) => a.distanceM - b.distanceM);

    this.cache.set(key, { stations, fetchedAt: Date.now() });
    return stations;
  }
}

export const FuelStopService = new FuelStopServiceImpl();
