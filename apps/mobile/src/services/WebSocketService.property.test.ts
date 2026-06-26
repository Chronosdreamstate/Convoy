/**
 * Property tests for WebSocketService.computeBackoffMs.
 *
 * Property 91: computeBackoffMs is always non-negative
 *   Validates: Requirements 43.2
 *
 * Property 92: computeBackoffMs never exceeds maxMs * 1.25
 *   Validates: Requirements 43.2
 *
 * Property 93: computeBackoffMs at large attempt counts converges to [maxMs*0.75, maxMs*1.25]
 *   Validates: Requirements 43.2
 *
 * Property 94: computeBackoffMs at attempt=0 returns a value within jitter range of initialMs
 *   Validates: Requirements 43.2
 */

import fc from 'fast-check';
import { computeBackoffMs } from './WebSocketService';

const NUM_SAMPLES = 50; // run each probabilistic check this many times

/**
 * Invoke fn N times and collect all results — used to verify
 * that random jitter never pushes the result out of bounds.
 */
function sample(fn: () => number, n: number): number[] {
  return Array.from({ length: n }, fn);
}

// ---------------------------------------------------------------------------
// Property 91: Result is always non-negative
// ---------------------------------------------------------------------------
describe('Property 91: computeBackoffMs is always non-negative', () => {
  it('non-negative for any attempt/initialMs/maxMs combination', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 1, max: 60_000 }),
        (attempt, initialMs, maxMs) => {
          // Run multiple times to exercise the random jitter
          const results = sample(() => computeBackoffMs(attempt, initialMs, maxMs), NUM_SAMPLES);
          for (const r of results) {
            expect(r).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it('non-negative at attempt=0 with defaults', () => {
    const results = sample(() => computeBackoffMs(0), NUM_SAMPLES);
    for (const r of results) expect(r).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Property 92: Result never exceeds maxMs * 1.25
// ---------------------------------------------------------------------------
describe('Property 92: computeBackoffMs never exceeds maxMs * 1.25', () => {
  it('upper-bounded by maxMs * 1.25 for any inputs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 1, max: 5_000 }),
        fc.integer({ min: 1_000, max: 60_000 }),
        (attempt, initialMs, maxMs) => {
          const ceiling = Math.ceil(maxMs * 1.25);
          const results = sample(() => computeBackoffMs(attempt, initialMs, maxMs), NUM_SAMPLES);
          for (const r of results) {
            expect(r).toBeLessThanOrEqual(ceiling);
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it('upper-bounded at extremely high attempt counts (well past the cap)', () => {
    const maxMs = 30_000;
    const ceiling = Math.ceil(maxMs * 1.25);
    const results = sample(() => computeBackoffMs(1000, 1_000, maxMs), NUM_SAMPLES);
    for (const r of results) {
      expect(r).toBeLessThanOrEqual(ceiling);
    }
  });
});

// ---------------------------------------------------------------------------
// Property 93: At large attempt counts the result is near maxMs (within jitter)
// ---------------------------------------------------------------------------
describe('Property 93: At large attempt counts, result converges to [maxMs*0.75, maxMs*1.25]', () => {
  it('all samples at high attempt are within jitter range of maxMs', () => {
    const maxMs = 30_000;
    const floor = Math.floor(maxMs * 0.75);
    const ceiling = Math.ceil(maxMs * 1.25);

    // At attempt ≥ 20, base = min(1000 * 2^20, maxMs) = maxMs (well saturated)
    const results = sample(() => computeBackoffMs(20, 1_000, maxMs), NUM_SAMPLES);
    for (const r of results) {
      expect(r).toBeGreaterThanOrEqual(floor);
      expect(r).toBeLessThanOrEqual(ceiling);
    }
  });

  it('result range narrows correctly for smaller maxMs values', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5_000, max: 30_000 }), // maxMs
        (maxMs) => {
          const floor = Math.floor(maxMs * 0.75);
          const ceiling = Math.ceil(maxMs * 1.25);
          const results = sample(() => computeBackoffMs(50, 1_000, maxMs), NUM_SAMPLES);
          for (const r of results) {
            expect(r).toBeGreaterThanOrEqual(floor);
            expect(r).toBeLessThanOrEqual(ceiling);
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 94: At attempt=0, result is within jitter range of initialMs
// ---------------------------------------------------------------------------
describe('Property 94: At attempt=0, result is within jitter range of initialMs', () => {
  it('attempt=0 keeps result within [initialMs*0.75, initialMs*1.25]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 5_000 }), // initialMs
        (initialMs) => {
          const floor = Math.floor(initialMs * 0.75);
          const ceiling = Math.ceil(initialMs * 1.25);
          const results = sample(() => computeBackoffMs(0, initialMs, 60_000), NUM_SAMPLES);
          for (const r of results) {
            expect(r).toBeGreaterThanOrEqual(floor);
            expect(r).toBeLessThanOrEqual(ceiling);
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it('attempt=0 with default args stays within [750, 1250]', () => {
    const results = sample(() => computeBackoffMs(0), NUM_SAMPLES);
    for (const r of results) {
      expect(r).toBeGreaterThanOrEqual(750);
      expect(r).toBeLessThanOrEqual(1250);
    }
  });
});

// ---------------------------------------------------------------------------
// Deterministic edge cases
// ---------------------------------------------------------------------------
describe('computeBackoffMs edge cases', () => {
  it('result is an integer (Math.round applied)', () => {
    const results = sample(() => computeBackoffMs(2, 1_000, 30_000), NUM_SAMPLES);
    for (const r of results) {
      expect(Number.isInteger(r)).toBe(true);
    }
  });

  it('maxMs = initialMs at attempt=0 yields a result near initialMs', () => {
    const v = 5_000;
    const results = sample(() => computeBackoffMs(0, v, v), NUM_SAMPLES);
    for (const r of results) {
      expect(r).toBeGreaterThanOrEqual(Math.floor(v * 0.75));
      expect(r).toBeLessThanOrEqual(Math.ceil(v * 1.25));
    }
  });
});
