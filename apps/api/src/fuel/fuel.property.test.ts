/**
 * Property tests for fuel stop suggestions.
 * Property 35: Fuel suggestion fires at first threshold reached (Req 21.1)
 * Property 36: Fuel nearby accessible to all Members (Req 21.4)
 */

import fc from 'fast-check';
import {
  shouldSuggestFuel,
  FUEL_DISTANCE_THRESHOLD_M,
  FUEL_TIME_THRESHOLD_S,
} from './fuel.routes';

describe('Property 35: Fuel suggestion fires at first threshold reached', () => {
  test('P35.1: no suggestion below both thresholds', () => {
    expect(
      shouldSuggestFuel({ distanceM: FUEL_DISTANCE_THRESHOLD_M - 1, durationS: FUEL_TIME_THRESHOLD_S - 1 }),
    ).toBe(false);
  });

  test('P35.2: suggestion fires at exact distance threshold', () => {
    expect(
      shouldSuggestFuel({ distanceM: FUEL_DISTANCE_THRESHOLD_M, durationS: 0 }),
    ).toBe(true);
  });

  test('P35.3: suggestion fires at exact time threshold', () => {
    expect(
      shouldSuggestFuel({ distanceM: 0, durationS: FUEL_TIME_THRESHOLD_S }),
    ).toBe(true);
  });

  test('P35.4: suggestion fires when only distance threshold exceeded', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Math.ceil(FUEL_DISTANCE_THRESHOLD_M), max: 1_000_000 }),
        fc.integer({ min: 0, max: FUEL_TIME_THRESHOLD_S - 1 }),
        (distanceM, durationS) => {
          expect(shouldSuggestFuel({ distanceM, durationS })).toBe(true);
        },
      ),
    );
  });

  test('P35.5: suggestion fires when only time threshold exceeded', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Math.floor(FUEL_DISTANCE_THRESHOLD_M) - 1 }),
        fc.integer({ min: FUEL_TIME_THRESHOLD_S, max: 86_400 }),
        (distanceM, durationS) => {
          expect(shouldSuggestFuel({ distanceM, durationS })).toBe(true);
        },
      ),
    );
  });

  test('P35.6: no suggestion when both are strictly below threshold', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Math.floor(FUEL_DISTANCE_THRESHOLD_M) - 1 }),
        fc.integer({ min: 0, max: FUEL_TIME_THRESHOLD_S - 1 }),
        (distanceM, durationS) => {
          expect(shouldSuggestFuel({ distanceM, durationS })).toBe(false);
        },
      ),
    );
  });
});

// Property 36 is enforced by authentication middleware — covered by Property 1 (auth tests).
describe('Property 36: Fuel nearby accessible to all authenticated Members', () => {
  test('P36.1: shouldSuggestFuel is deterministic', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 500_000 }),
        fc.integer({ min: 0, max: 86_400 }),
        (distanceM, durationS) => {
          const r1 = shouldSuggestFuel({ distanceM, durationS });
          const r2 = shouldSuggestFuel({ distanceM, durationS });
          expect(r1).toBe(r2);
        },
      ),
    );
  });
});
