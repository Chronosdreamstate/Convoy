/**
 * Property 100: destinations.length never exceeds MAX_RECENT (5)
 *   After any sequence of addDestination calls the list is capped at 5.
 *   Validates: Requirements 18.1 (recent destinations bounded)
 *
 * Property 101: The most-recently added destination is always at index 0
 *   addDestination prepends the new item so it is always first.
 *   Validates: Requirements 18.2 (most recent first)
 *
 * Property 102: No duplicate ids after addDestination
 *   Adding a destination whose id already exists removes the old entry first.
 *   Validates: Requirements 18.3 (deduplication)
 */

import fc from 'fast-check';
import { applyAddDestination, MAX_RECENT, RecentDestination } from './recentDestinationsStore';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const fcDestinationId = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0);

function fcDestination(idArb: fc.Arbitrary<string> = fcDestinationId): fc.Arbitrary<RecentDestination> {
  return fc.record({
    id: idArb,
    name: fc.string({ minLength: 1, maxLength: 30 }),
    address: fc.string({ minLength: 1, maxLength: 60 }),
    lat: fc.float({ min: -90, max: 90, noNaN: true }),
    lng: fc.float({ min: -180, max: 180, noNaN: true }),
  });
}

/** Builds an initial list of 0–MAX_RECENT destinations with distinct ids. */
const fcInitialList: fc.Arbitrary<RecentDestination[]> = fc
  .array(fcDestination(), { minLength: 0, maxLength: MAX_RECENT })
  .map((arr) => {
    const seen = new Set<string>();
    return arr.filter((d) => {
      if (seen.has(d.id)) return false;
      seen.add(d.id);
      return true;
    });
  });

// ---------------------------------------------------------------------------
// Property 100: length is always ≤ MAX_RECENT
// ---------------------------------------------------------------------------
describe('Property 100: destinations.length never exceeds MAX_RECENT after any addDestination sequence', () => {
  it('bounded by MAX_RECENT for a single call on any starting list', () => {
    fc.assert(
      fc.property(
        fcInitialList,
        fcDestination(),
        (initial, newDest) => {
          const result = applyAddDestination(initial, newDest);
          expect(result.length).toBeLessThanOrEqual(MAX_RECENT);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('bounded by MAX_RECENT after a sequence of up to 20 calls', () => {
    fc.assert(
      fc.property(
        fc.array(fcDestination(), { minLength: 1, maxLength: 20 }),
        (sequence) => {
          let destinations: RecentDestination[] = [];
          for (const d of sequence) {
            destinations = applyAddDestination(destinations, d);
            expect(destinations.length).toBeLessThanOrEqual(MAX_RECENT);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('adding exactly MAX_RECENT+1 distinct items caps at MAX_RECENT', () => {
    fc.assert(
      fc.property(
        fc.array(
          fcDestination(fcDestinationId),
          { minLength: MAX_RECENT + 1, maxLength: MAX_RECENT + 1 },
        ).filter((arr) => new Set(arr.map((d) => d.id)).size === arr.length),
        (items) => {
          let destinations: RecentDestination[] = [];
          for (const d of items) {
            destinations = applyAddDestination(destinations, d);
          }
          expect(destinations).toHaveLength(MAX_RECENT);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 101: Most recently added destination is always at index 0
// ---------------------------------------------------------------------------
describe('Property 101: The most-recently added destination is always at index 0', () => {
  it('new destination appears at index 0 regardless of starting list', () => {
    fc.assert(
      fc.property(
        fcInitialList,
        fcDestination(),
        (initial, newDest) => {
          const result = applyAddDestination(initial, newDest);
          expect(result[0]).toEqual(newDest);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('re-adding an existing destination moves it to index 0', () => {
    fc.assert(
      fc.property(
        fc.array(
          fcDestination(),
          { minLength: 2, maxLength: MAX_RECENT },
        ).filter((arr) => new Set(arr.map((d) => d.id)).size === arr.length),
        fc.integer({ min: 1, max: MAX_RECENT - 1 }),
        (initial, targetIdx) => {
          fc.pre(targetIdx < initial.length);
          const target = initial[targetIdx];
          const result = applyAddDestination(initial, target);
          expect(result[0].id).toBe(target.id);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 102: No duplicate ids after addDestination
// ---------------------------------------------------------------------------
describe('Property 102: No duplicate ids exist after addDestination', () => {
  it('result contains no duplicate ids for any starting list and new destination', () => {
    fc.assert(
      fc.property(
        fcInitialList,
        fcDestination(),
        (initial, newDest) => {
          const result = applyAddDestination(initial, newDest);
          const ids = result.map((d) => d.id);
          const uniqueIds = new Set(ids);
          expect(uniqueIds.size).toBe(ids.length);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('adding an item with an existing id does not increase the list length', () => {
    fc.assert(
      fc.property(
        fc.array(
          fcDestination(),
          { minLength: 1, maxLength: MAX_RECENT },
        ).filter((arr) => new Set(arr.map((d) => d.id)).size === arr.length),
        fc.integer({ min: 0, max: MAX_RECENT - 1 }),
        (initial, targetIdx) => {
          fc.pre(targetIdx < initial.length);
          const existingId = initial[targetIdx].id;
          const duplicate = { ...initial[targetIdx], name: 'Updated Name', address: 'New Address' };
          const result = applyAddDestination(initial, duplicate);
          expect(result.length).toBe(initial.length);
          expect(result.filter((d) => d.id === existingId)).toHaveLength(1);
          expect(result[0].id).toBe(existingId);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('after any sequence of adds the id set is stable', () => {
    fc.assert(
      fc.property(
        fc.array(
          fcDestination(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f')),
          { minLength: 5, maxLength: 15 },
        ),
        (sequence) => {
          let destinations: RecentDestination[] = [];
          for (const d of sequence) {
            destinations = applyAddDestination(destinations, d);
            const ids = destinations.map((x) => x.id);
            expect(new Set(ids).size).toBe(ids.length);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
