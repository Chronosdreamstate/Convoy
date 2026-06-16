/** Mapbox Geocoding destination search (Req 18.1–18.9). */

export interface SearchResult {
  id: string;
  name: string;
  address: string;
  category: string | null;
  lat: number;
  lng: number;
}

interface MapboxFeature {
  id: string;
  place_name: string;
  text: string;
  place_type: string[];
  center: [number, number]; // [lng, lat]
}

interface MapboxGeocodeResponse {
  features?: MapboxFeature[];
}

/** Minimal network abstraction so SearchService is testable without real fetch. */
export type SearchFetcher = (url: string) => Promise<MapboxGeocodeResponse>;

export const MAX_SEARCH_RESULTS = 10; // Property 29: cap at 10

const MIN_QUERY_LENGTH = 3;

export class SearchService {
  constructor(
    private readonly token: string,
    private readonly isOnline: () => boolean,
    private readonly fetcher: SearchFetcher = defaultFetcher,
  ) {}

  /**
   * Search for destinations.
   * Returns [] if offline (Property 30) or query < 3 chars.
   * Returns at most 10 results (Property 29).
   */
  async search(query: string): Promise<SearchResult[]> {
    // Disabled while offline (Property 30)
    if (!this.isOnline()) return [];

    if (query.trim().length < MIN_QUERY_LENGTH) return [];

    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${this.token}&limit=10&types=place,address,poi`;

    const data = await this.fetcher(url);
    return processSearchResults(data.features ?? []);
  }
}

/**
 * Normalise Mapbox features into SearchResult[].
 * Exported for Property 29 testing.
 */
export function processSearchResults(features: MapboxFeature[]): SearchResult[] {
  return features
    .slice(0, MAX_SEARCH_RESULTS) // cap at 10 (Property 29)
    .map((f) => ({
      id: f.id,
      name: f.text,
      address: f.place_name,
      category: f.place_type[0] ?? null,
      lat: f.center[1],
      lng: f.center[0],
    }));
}

async function defaultFetcher(url: string): Promise<MapboxGeocodeResponse> {
  const res = await fetch(url);
  if (!res.ok) return { features: [] };
  return res.json() as Promise<MapboxGeocodeResponse>;
}
