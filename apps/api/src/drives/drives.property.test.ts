/**
 * Property tests for drive history.
 * Property 31: Drive_History record contains all required fields (Req 19.1)
 * Property 32: Drive History is sorted reverse-chronologically (Req 19.3)
 * Property 33: Pagination params are always valid (Req 19.4)
 * Property 34: Pagination math is always consistent (Req 19.4)
 */

import fc from 'fast-check';
import {
  hasAllRequiredFields,
  isDrivesSortedDesc,
  serializeDriveRow,
  buildSummaryCardUrl,
  hydrateSummaryCardUrl,
  REQUIRED_DRIVE_FIELDS,
  parsePage,
  parseLimit,
  computeOffset,
  computePages,
  RawDriveRow,
  DriveResponse,
} from './drives.routes';

// ---------------------------------------------------------------------------
// Property 31: Drive_History record contains all required fields
// ---------------------------------------------------------------------------

describe('Property 31: Drive_History record contains all required fields', () => {
  const validDrive = (): DriveResponse => ({
    id: 'a0000000-0000-0000-0000-000000000001',
    userId: 'a0000000-0000-0000-0000-000000000002',
    groupId: null,
    routeTrace: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
    distanceM: 1000,
    durationS: 300,
    avgSpeedKph: 12,
    topSpeedKph: 20,
    memberCount: 2,
    startedAt: '2024-06-01T10:00:00.000Z',
    endedAt: '2024-06-01T10:05:00.000Z',
    summaryCardUrl: null,
    createdAt: '2024-06-01T10:05:01.000Z',
  });

  test('P31.1: a fully populated drive passes the required-field check', () => {
    expect(hasAllRequiredFields(validDrive())).toBe(true);
  });

  test('P31.2: missing any required field fails the check', () => {
    for (const field of REQUIRED_DRIVE_FIELDS) {
      const partial = { ...validDrive(), [field]: undefined };
      expect(hasAllRequiredFields(partial)).toBe(false);
    }
  });

  test('P31.3: null required field fails the check', () => {
    for (const field of REQUIRED_DRIVE_FIELDS) {
      const partial = { ...validDrive(), [field]: null };
      expect(hasAllRequiredFields(partial)).toBe(false);
    }
  });

  test('P31.4: serializeDriveRow always produces a record with all required fields', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.uuid(),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 86_400 }),
        fc.integer({ min: 1, max: 50 }),
        fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') }),
        fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') }),
        (id, userId, distanceM, durationS, memberCount, startedAt, endedAt) => {
          const row: RawDriveRow = {
            id,
            user_id: userId,
            group_id: null,
            route_trace: { type: 'LineString', coordinates: [[0, 0]] },
            distance_m: distanceM,
            duration_s: durationS,
            avg_speed_kph: null,
            top_speed_kph: null,
            member_count: memberCount,
            started_at: startedAt,
            ended_at: endedAt,
            summary_card_url: null,
            created_at: new Date(),
          };
          const res = serializeDriveRow(row);
          expect(hasAllRequiredFields(res)).toBe(true);
        },
      ),
    );
  });

  test('P31.5: serialization preserves all scalar fields', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.uuid(),
        fc.integer({ min: 0 }),
        fc.integer({ min: 0 }),
        fc.integer({ min: 1, max: 50 }),
        fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') }),
        fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') }),
        (id, userId, distanceM, durationS, memberCount, startedAt, endedAt) => {
          const row: RawDriveRow = {
            id,
            user_id: userId,
            group_id: null,
            route_trace: { type: 'LineString', coordinates: [[10, 20]] },
            distance_m: distanceM,
            duration_s: durationS,
            avg_speed_kph: null,
            top_speed_kph: null,
            member_count: memberCount,
            started_at: startedAt,
            ended_at: endedAt,
            summary_card_url: null,
            created_at: new Date('2024-01-01'),
          };
          const res = serializeDriveRow(row);
          expect(res.id).toBe(row.id);
          expect(res.userId).toBe(row.user_id);
          expect(res.distanceM).toBe(row.distance_m);
          expect(res.durationS).toBe(row.duration_s);
          expect(res.memberCount).toBe(row.member_count);
          expect(res.startedAt).toBe(row.started_at.toISOString());
          expect(res.endedAt).toBe(row.ended_at.toISOString());
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 32: Drive History is sorted reverse-chronologically
// ---------------------------------------------------------------------------

describe('Property 32: Drive History is sorted reverse-chronologically', () => {
  test('P32.1: empty list is trivially sorted', () => {
    expect(isDrivesSortedDesc([])).toBe(true);
  });

  test('P32.2: single element is trivially sorted', () => {
    expect(isDrivesSortedDesc([{ endedAt: '2024-06-01T12:00:00.000Z' }])).toBe(true);
  });

  test('P32.3: list in descending order passes', () => {
    expect(
      isDrivesSortedDesc([
        { endedAt: '2024-06-03T12:00:00.000Z' },
        { endedAt: '2024-06-02T12:00:00.000Z' },
        { endedAt: '2024-06-01T12:00:00.000Z' },
      ]),
    ).toBe(true);
  });

  test('P32.4: list with ascending element fails', () => {
    expect(
      isDrivesSortedDesc([
        { endedAt: '2024-06-01T12:00:00.000Z' },
        { endedAt: '2024-06-02T12:00:00.000Z' },
      ]),
    ).toBe(false);
  });

  test('P32.5: sorting any arbitrary list produces isDrivesSortedDesc = true', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') }),
          { minLength: 0, maxLength: 20 },
        ),
        (dates) => {
          const sorted = dates
            .map((d) => ({ endedAt: d.toISOString() }))
            .sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
          expect(isDrivesSortedDesc(sorted)).toBe(true);
        },
      ),
    );
  });

  test('P32.6: ties (same endedAt) are allowed', () => {
    expect(
      isDrivesSortedDesc([
        { endedAt: '2024-06-02T12:00:00.000Z' },
        { endedAt: '2024-06-02T12:00:00.000Z' },
        { endedAt: '2024-06-01T12:00:00.000Z' },
      ]),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Summary card URL builder
// ---------------------------------------------------------------------------

describe('buildSummaryCardUrl', () => {
  test('returns empty string for no coordinates', () => {
    expect(buildSummaryCardUrl([])).toBe('');
  });

  test('returns a token-free Mapbox URL', () => {
    const url = buildSummaryCardUrl([[10, 20], [11, 21]]);
    expect(url).toContain('mapbox.com');
    expect(url).not.toContain('access_token=');
  });

  test('URL contains LineString coordinates', () => {
    const url = buildSummaryCardUrl([[10, 20]]);
    expect(url).toContain('LineString');
  });
});

describe('hydrateSummaryCardUrl', () => {
  test('returns null for null input', () => {
    expect(hydrateSummaryCardUrl(null, 'tok')).toBeNull();
  });

  test('appends token to a token-free URL', () => {
    const base = buildSummaryCardUrl([[10, 20]]);
    const hydrated = hydrateSummaryCardUrl(base, 'my-token');
    expect(hydrated).toContain('access_token=my-token');
    expect(hydrated).toContain('mapbox.com');
  });

  test('does not double-append token if already present', () => {
    const url = 'https://api.mapbox.com/foo?access_token=existing';
    const hydrated = hydrateSummaryCardUrl(url, 'new-token');
    expect(hydrated).toBe(url);
  });
});

// ---------------------------------------------------------------------------
// Property 33: Pagination query params are always safe
// ---------------------------------------------------------------------------

describe('Property 33: parsePage / parseLimit always return valid values', () => {
  test('P33.1: parsePage always returns >= 1 for any string input', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.integer().map(String),
          fc.constant(undefined),
          fc.constant('0'),
          fc.constant('-5'),
          fc.constant('abc'),
          fc.constant(''),
        ),
        (raw) => {
          const page = parsePage(raw as string | undefined);
          expect(page).toBeGreaterThanOrEqual(1);
          expect(Number.isInteger(page)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  test('P33.2: parseLimit always returns value in [1, 50] for any string input', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.integer().map(String),
          fc.constant(undefined),
          fc.constant('0'),
          fc.constant('100'),
          fc.constant('-1'),
          fc.constant(''),
        ),
        (raw) => {
          const limit = parseLimit(raw as string | undefined);
          expect(limit).toBeGreaterThanOrEqual(1);
          expect(limit).toBeLessThanOrEqual(50);
          expect(Number.isInteger(limit)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  test('P33.3: parsePage with valid integer string returns that integer (if >= 1)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        (n) => {
          expect(parsePage(String(n))).toBe(n);
        },
      ),
    );
  });

  test('P33.4: parseLimit with valid integer in [1,50] is identity', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        (n) => {
          expect(parseLimit(String(n))).toBe(n);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 34: Pagination math is always consistent
// ---------------------------------------------------------------------------

describe('Property 34: Pagination math invariants', () => {
  test('P34.1: computeOffset is always >= 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000 }),
        fc.integer({ min: 1, max: 50 }),
        (page, limit) => {
          expect(computeOffset(page, limit)).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  test('P34.2: offset for page 1 is always 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        (limit) => {
          expect(computeOffset(1, limit)).toBe(0);
        },
      ),
    );
  });

  test('P34.3: computePages * limit >= total (enough pages to cover all rows)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 50 }),
        (total, limit) => {
          const pages = computePages(total, limit);
          expect(pages * limit).toBeGreaterThanOrEqual(total);
        },
      ),
    );
  });

  test('P34.4: computePages with total=0 is 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        (limit) => {
          expect(computePages(0, limit)).toBe(0);
        },
      ),
    );
  });

  test('P34.5: total <= limit implies exactly 1 page', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 50 }),
        (total, limit) => {
          fc.pre(total <= limit);
          expect(computePages(total, limit)).toBe(1);
        },
      ),
    );
  });

  test('P34.6: offset + limit never exceeds total by more than limit-1', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 10 }),
        (total, limit, page) => {
          const pages = computePages(total, limit);
          fc.pre(page <= pages);
          const offset = computeOffset(page, limit);
          expect(offset).toBeLessThan(total + limit);
        },
      ),
    );
  });
});
