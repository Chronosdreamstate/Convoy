/**
 * Property 18: Hazard expiry is always creation/confirmation time + 30 minutes
 *   computeExpiresAt(nowMs) always returns exactly HAZARD_EXPIRY_MS after nowMs.
 *   Validates: Requirements 11.3, 11.5
 *
 * Property 19: 3 dismissals removes hazard
 *   processDismissal() returns dismissed=true only when the new total reaches 3.
 *   Validates: Requirement 11.6
 *
 * Property 20: Hazard proximity alert triggers at or within configured distance
 *   shouldAlertHazard(distanceM, thresholdM) returns true iff distanceM <= thresholdM.
 *   Validates: Requirements 11.7, 11.8
 *
 * Property 22: Hazard report serialization round-trip
 *   serializeHazardRow() preserves every field without loss or corruption.
 *   Validates: Requirements 12.1, 12.2, 12.3
 */

import fc from 'fast-check';
import {
  computeExpiresAt,
  processDismissal,
  shouldAlertHazard,
  serializeHazardRow,
  HAZARD_EXPIRY_MS,
  HAZARD_TYPES,
  RawHazardRow,
} from './hazards.routes';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const epochArb = fc.integer({ min: 0, max: 2_000_000_000_000 });

const rawRowArb = fc.record({
  id: fc.uuid(),
  hazard_type: fc.constantFrom(...HAZARD_TYPES),
  lat: fc.float({ min: -90, max: 90, noNaN: true }),
  lng: fc.float({ min: -180, max: 180, noNaN: true }),
  status: fc.constantFrom('active', 'expired', 'dismissed'),
  expires_at: epochArb.map((ms) => new Date(ms)),
  confirmation_count: fc.nat({ max: 50 }),
  dismissal_count: fc.nat({ max: 50 }),
  created_at: epochArb.map((ms) => new Date(ms)),
}) satisfies fc.Arbitrary<RawHazardRow>;

// ---------------------------------------------------------------------------
// Property 18: Expiry is always nowMs + 30 minutes
// ---------------------------------------------------------------------------

describe('Property 18: Hazard expiry is always creation/confirmation time + 30 minutes', () => {
  it('computeExpiresAt(nowMs) returns Date 30 minutes later for any epoch', () => {
    fc.assert(
      fc.property(epochArb, (nowMs) => {
        const result = computeExpiresAt(nowMs);
        expect(result.getTime()).toBe(nowMs + HAZARD_EXPIRY_MS);
      }),
      { numRuns: 200 },
    );
  });

  it('HAZARD_EXPIRY_MS is exactly 1800000 ms (30 minutes)', () => {
    expect(HAZARD_EXPIRY_MS).toBe(30 * 60 * 1000);
  });

  it('expiry is always strictly in the future relative to nowMs', () => {
    fc.assert(
      fc.property(epochArb, (nowMs) => {
        const expiresAt = computeExpiresAt(nowMs);
        expect(expiresAt.getTime()).toBeGreaterThan(nowMs);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 19: 3 dismissals removes hazard
// ---------------------------------------------------------------------------

describe('Property 19: 3 dismissals removes hazard', () => {
  it('processDismissal returns dismissed=false when new count < 3', () => {
    fc.assert(
      fc.property(fc.nat({ max: 1 }), (currentCount) => {
        const { newCount, dismissed } = processDismissal(currentCount);
        expect(newCount).toBe(currentCount + 1);
        expect(dismissed).toBe(false);
      }),
      { numRuns: 50 },
    );
  });

  it('processDismissal returns dismissed=true exactly when new count >= 3', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 50 }), (currentCount) => {
        const { newCount, dismissed } = processDismissal(currentCount);
        expect(newCount).toBe(currentCount + 1);
        expect(dismissed).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it('third dismissal (currentCount=2) triggers removal', () => {
    const { newCount, dismissed } = processDismissal(2);
    expect(newCount).toBe(3);
    expect(dismissed).toBe(true);
  });

  it('second dismissal (currentCount=1) does not trigger removal', () => {
    const { newCount, dismissed } = processDismissal(1);
    expect(newCount).toBe(2);
    expect(dismissed).toBe(false);
  });

  it('first dismissal (currentCount=0) does not trigger removal', () => {
    const { newCount, dismissed } = processDismissal(0);
    expect(newCount).toBe(1);
    expect(dismissed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property 20: Hazard proximity alert triggers at or within configured distance
// ---------------------------------------------------------------------------

describe('Property 20: Hazard proximity alert triggers at or within configured distance', () => {
  it('shouldAlertHazard returns true when distance <= threshold', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 10_000, noNaN: true }),
        fc.float({ min: 0, max: 10_000, noNaN: true }),
        (distance, threshold) => {
          const result = shouldAlertHazard(distance, threshold);
          expect(result).toBe(distance <= threshold);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('alert fires exactly at the threshold boundary', () => {
    expect(shouldAlertHazard(805, 805)).toBe(true);
    expect(shouldAlertHazard(806, 805)).toBe(false);
    expect(shouldAlertHazard(804, 805)).toBe(true);
  });

  it('alert fires for distance 0 regardless of threshold (> 0)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50_000 }), (threshold) => {
        expect(shouldAlertHazard(0, threshold)).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it('alert never fires when threshold is 0 and distance > 0', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50_000 }), (distance) => {
        expect(shouldAlertHazard(distance, 0)).toBe(false);
      }),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 22: Hazard report serialization round-trip
// ---------------------------------------------------------------------------

describe('Property 22: Hazard report serialization round-trip', () => {
  it('serializeHazardRow preserves all fields without corruption', () => {
    fc.assert(
      fc.property(rawRowArb, (row) => {
        const resp = serializeHazardRow(row);

        expect(resp.id).toBe(row.id);
        expect(resp.type).toBe(row.hazard_type);
        expect(resp.lat).toBe(row.lat);
        expect(resp.lng).toBe(row.lng);
        expect(resp.status).toBe(row.status);
        expect(resp.confirmationCount).toBe(row.confirmation_count);
        expect(resp.dismissalCount).toBe(row.dismissal_count);
        // Dates converted to ISO string without timestamp loss
        expect(new Date(resp.expiresAt).getTime()).toBe(row.expires_at.getTime());
        expect(new Date(resp.createdAt).getTime()).toBe(row.created_at.getTime());
      }),
      { numRuns: 200 },
    );
  });

  it('serialized lat/lng are finite numbers (no NaN or Infinity)', () => {
    fc.assert(
      fc.property(rawRowArb, (row) => {
        const resp = serializeHazardRow(row);
        expect(isFinite(resp.lat)).toBe(true);
        expect(isFinite(resp.lng)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('expiresAt and createdAt are valid ISO-8601 strings', () => {
    fc.assert(
      fc.property(rawRowArb, (row) => {
        const resp = serializeHazardRow(row);
        expect(resp.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        expect(resp.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      }),
      { numRuns: 100 },
    );
  });

  it('type field is always one of the 9 valid hazard types (when row uses a valid type)', () => {
    fc.assert(
      fc.property(rawRowArb, (row) => {
        const resp = serializeHazardRow(row);
        expect(HAZARD_TYPES).toContain(resp.type);
      }),
      { numRuns: 100 },
    );
  });
});
