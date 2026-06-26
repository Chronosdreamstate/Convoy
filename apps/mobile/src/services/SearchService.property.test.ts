/**
 * Property tests for SearchService / processSearchResults.
 *
 * Property 113: Result count never exceeds MAX_SEARCH_RESULTS
 *   processSearchResults caps output at 10 regardless of input length.
 *   Validates: Requirement 18.1 (Property 29)
 *
 * Property 114: Offline → empty results
 *   When isOnline() returns false, search() always returns [].
 *   Validates: Requirement 18.4 (Property 30)
 *
 * Property 115: Short query → empty results
 *   Queries shorter than 3 non-whitespace characters return [] without
 *   calling the fetcher.
 *   Validates: Requirement 18.2
 *
 * Property 116: Output fields are correctly mapped from Mapbox features
 *   For any valid MapboxFeature the mapping is: id→id, text→name,
 *   place_name→address, center[1]→lat, center[0]→lng, place_type[0]→category.
 *   Validates: Requirement 18.5
 *
 * Property 117: No duplicate ids in results for any input feature list
 *   processSearchResults preserves whatever IDs Mapbox returns; if the
 *   upstream list itself has no duplicates, the output has none either.
 *   Validates: Requirement 18.3
 */

import fc from 'fast-check';
import {
  SearchService,
  SearchResult,
  processSearchResults,
  MAX_SEARCH_RESULTS,
} from './SearchService';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const fcNonEmptyString = fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0);

const fcMapboxFeature = fc.record({
  id: fcNonEmptyString,
  place_name: fcNonEmptyString,
  text: fcNonEmptyString,
  place_type: fc.array(
    fc.constantFrom('place', 'address', 'poi', 'region', 'country'),
    { minLength: 1, maxLength: 3 },
  ),
  center: fc.tuple(
    fc.float({ min: -180, max: 180, noNaN: true }),
    fc.float({ min: -90, max: 90, noNaN: true }),
  ),
});

/** Feature list with no duplicate ids. */
const fcUniqueFeatures = fc
  .array(fcMapboxFeature, { minLength: 0, maxLength: 30 })
  .map((arr) => {
    const seen = new Set<string>();
    return arr.filter((f) => {
      if (seen.has(f.id)) return false;
      seen.add(f.id);
      return true;
    });
  });

// ---------------------------------------------------------------------------
// Property 113: Result count never exceeds MAX_SEARCH_RESULTS
// ---------------------------------------------------------------------------

describe('Property 113: Result count never exceeds MAX_SEARCH_RESULTS', () => {
  it('caps output at 10 for any number of input features', () => {
    fc.assert(
      fc.property(
        fc.array(fcMapboxFeature, { minLength: 0, maxLength: 50 }),
        (features) => {
          const results = processSearchResults(features);
          expect(results.length).toBeLessThanOrEqual(MAX_SEARCH_RESULTS);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('returns exactly min(n, MAX_SEARCH_RESULTS) results for n unique features', () => {
    fc.assert(
      fc.property(
        fcUniqueFeatures,
        (features) => {
          const results = processSearchResults(features);
          expect(results.length).toBe(Math.min(features.length, MAX_SEARCH_RESULTS));
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 114: Offline → empty results
// ---------------------------------------------------------------------------

describe('Property 114: Offline → search always returns []', () => {
  it('returns [] for any query when isOnline() is false', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 3, maxLength: 50 }),
        async (query) => {
          const fetcherSpy = jest.fn();
          const svc = new SearchService('tok', () => false, fetcherSpy);

          const results = await svc.search(query);

          expect(results).toEqual([]);
          expect(fetcherSpy).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 115: Short query → empty results without calling fetcher
// ---------------------------------------------------------------------------

describe('Property 115: Short query (<3 non-whitespace chars) → []', () => {
  it('returns [] without calling the fetcher for any too-short query', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 10 }).filter((s) => s.trim().length < 3),
        async (shortQuery) => {
          const fetcherSpy = jest.fn();
          const svc = new SearchService('tok', () => true, fetcherSpy);

          const results = await svc.search(shortQuery);

          expect(results).toEqual([]);
          expect(fetcherSpy).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('does NOT return [] for queries with 3+ non-whitespace chars (fetcher is called)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 3, maxLength: 30 }).filter((s) => s.trim().length >= 3),
        async (query) => {
          const fetcherSpy = jest.fn().mockResolvedValue({ features: [] });
          const svc = new SearchService('tok', () => true, fetcherSpy);

          await svc.search(query);

          expect(fetcherSpy).toHaveBeenCalledTimes(1);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 116: Output fields are correctly mapped from Mapbox features
// ---------------------------------------------------------------------------

describe('Property 116: Output fields correctly mapped from Mapbox features', () => {
  it('maps id, text, place_name, center, place_type correctly for any feature', () => {
    fc.assert(
      fc.property(
        fcMapboxFeature,
        (feature) => {
          const [result] = processSearchResults([feature]);

          expect(result.id).toBe(feature.id);
          expect(result.name).toBe(feature.text);
          expect(result.address).toBe(feature.place_name);
          expect(result.lat).toBe(feature.center[1]);
          expect(result.lng).toBe(feature.center[0]);
          expect(result.category).toBe(feature.place_type[0] ?? null);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('all required SearchResult fields are present and non-null for any feature', () => {
    fc.assert(
      fc.property(
        fcMapboxFeature,
        (feature) => {
          const [result] = processSearchResults([feature]) as [SearchResult];

          expect(typeof result.id).toBe('string');
          expect(typeof result.name).toBe('string');
          expect(typeof result.address).toBe('string');
          expect(typeof result.lat).toBe('number');
          expect(typeof result.lng).toBe('number');
          // category is string | null — either is fine
          expect(result.category === null || typeof result.category === 'string').toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('lat is center[1] and lng is center[0] — axes not swapped', () => {
    fc.assert(
      fc.property(
        fc.float({ min: -180, max: 180, noNaN: true }),
        fc.float({ min: -90, max: 90, noNaN: true }),
        (lng, lat) => {
          const feature = {
            id: 'f1',
            place_name: 'Somewhere',
            text: 'Somewhere',
            place_type: ['place'],
            center: [lng, lat] as [number, number],
          };
          const [result] = processSearchResults([feature]);
          expect(result.lat).toBe(lat);
          expect(result.lng).toBe(lng);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 117: No duplicate ids in output when input has no duplicate ids
// ---------------------------------------------------------------------------

describe('Property 117: No duplicate ids in results when input ids are unique', () => {
  it('output ids are unique whenever input ids are unique', () => {
    fc.assert(
      fc.property(
        fcUniqueFeatures,
        (features) => {
          const results = processSearchResults(features);
          const ids = results.map((r) => r.id);
          expect(new Set(ids).size).toBe(ids.length);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('preserves relative order of features within the cap', () => {
    fc.assert(
      fc.property(
        fcUniqueFeatures,
        (features) => {
          const results = processSearchResults(features);
          const expectedIds = features.slice(0, MAX_SEARCH_RESULTS).map((f) => f.id);
          expect(results.map((r) => r.id)).toEqual(expectedIds);
        },
      ),
      { numRuns: 200 },
    );
  });
});
