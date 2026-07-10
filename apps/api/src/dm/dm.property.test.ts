/**
 * Property tests for the DM channel pair normalization backing the
 * uq_convoy_groups_dm_pair unique index (migration 033).
 *
 * POST /dm stores the participant pair as (dm_user_a, dm_user_b) normalized
 * by normalizeDmPair(); migration 033's backfill normalizes the same pairs
 * with Postgres LEAST(user_id)/GREATEST(user_id) (uuid byte-wise ordering).
 * For the unique index to converge concurrent creates onto ONE row, every
 * code path must produce the identical ordered pair — these properties pin
 * that down.
 */

import fc from 'fast-check';
import { normalizeDmPair } from './dm.routes';

/** Postgres compares uuids byte-wise: replicate that comparison here. */
function pgUuidCompare(a: string, b: string): number {
  const bytes = (u: string) => {
    const hex = u.replace(/-/g, '').toLowerCase();
    const out: number[] = [];
    for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
    return out;
  };
  const ba = bytes(a);
  const bb = bytes(b);
  for (let i = 0; i < ba.length; i++) {
    if (ba[i] !== bb[i]) return ba[i] < bb[i] ? -1 : 1;
  }
  return 0;
}

describe('normalizeDmPair', () => {
  it('Property: symmetric — both argument orders produce the identical pair', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (a, b) => {
        expect(normalizeDmPair(a, b)).toEqual(normalizeDmPair(b, a));
      }),
      { numRuns: 200 },
    );
  });

  it('Property: ordered — first element strictly precedes the second for distinct users', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (a, b) => {
        fc.pre(a.toLowerCase() !== b.toLowerCase());
        const [x, y] = normalizeDmPair(a, b);
        expect(x < y).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('Property: agrees with Postgres uuid ordering (byte-wise), so it matches migration 033 MIN/MAX backfill', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (a, b) => {
        fc.pre(a.toLowerCase() !== b.toLowerCase());
        const [x, y] = normalizeDmPair(a, b);
        expect(pgUuidCompare(x, y)).toBe(-1);
        // The normalized pair is exactly {min, max} under PG ordering
        const [lo, hi] = pgUuidCompare(a.toLowerCase(), b.toLowerCase()) < 0
          ? [a.toLowerCase(), b.toLowerCase()]
          : [b.toLowerCase(), a.toLowerCase()];
        expect(x).toBe(lo);
        expect(y).toBe(hi);
      }),
      { numRuns: 200 },
    );
  });

  it('Property: canonical — output is lowercase and case-insensitive in its inputs', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (a, b) => {
        const upper = normalizeDmPair(a.toUpperCase(), b.toUpperCase());
        const lower = normalizeDmPair(a.toLowerCase(), b.toLowerCase());
        expect(upper).toEqual(lower);
        expect(upper[0]).toBe(upper[0].toLowerCase());
        expect(upper[1]).toBe(upper[1].toLowerCase());
      }),
      { numRuns: 200 },
    );
  });

  it('Property: idempotent — re-normalizing an already normalized pair is a no-op', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (a, b) => {
        const first = normalizeDmPair(a, b);
        expect(normalizeDmPair(first[0], first[1])).toEqual(first);
      }),
      { numRuns: 200 },
    );
  });
});
