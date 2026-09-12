/**
 * Contract tests for the shared local-calendar helpers.
 *
 * Every case is built with the LOCAL-field Date constructor (`new Date(y, m, d,
 * h)`) and asserts a LOCAL-calendar answer, so the expectations hold in any
 * timezone — this repo's CI box and dev machines sit in one zone and Node on
 * Windows ignores the TZ env var, so a test that leaned on the machine's offset
 * would prove nothing.
 */

import { addLocalDays, localDayDiff, localDayKey, startOfLocalDay } from './datetime';

describe('localDayKey', () => {
  it('keys the LOCAL calendar day, not the UTC one', () => {
    // 23:30 and 00:30 local straddle midnight UTC in one direction or the
    // other from anywhere on earth — `toISOString().slice(0,10)` gets one wrong.
    expect(localDayKey(new Date(2026, 8, 11, 23, 30))).toBe('2026-09-11');
    expect(localDayKey(new Date(2026, 8, 12, 0, 30))).toBe('2026-09-12');
  });

  it('zero-pads month and day so keys sort lexicographically', () => {
    expect(localDayKey(new Date(2026, 0, 5, 12, 0))).toBe('2026-01-05');
  });

  it('returns an empty key for an unparseable value rather than NaN text', () => {
    expect(localDayKey('not a date')).toBe('');
  });
});

describe('addLocalDays', () => {
  it('crosses month and year boundaries', () => {
    expect(localDayKey(addLocalDays(new Date(2026, 0, 31, 9, 0), 1))).toBe('2026-02-01');
    expect(localDayKey(addLocalDays(new Date(2026, 2, 1, 9, 0), -1))).toBe('2026-02-28');
    expect(localDayKey(addLocalDays(new Date(2026, 11, 31, 9, 0), 1))).toBe('2027-01-01');
  });

  it('lands on Feb 29 in a leap year', () => {
    expect(localDayKey(addLocalDays(new Date(2028, 1, 28, 9, 0), 1))).toBe('2028-02-29');
  });

  it('does not mutate its argument', () => {
    const original = new Date(2026, 8, 12, 9, 0);
    addLocalDays(original, 5);
    expect(localDayKey(original)).toBe('2026-09-12');
  });
});

describe('localDayDiff', () => {
  it('counts whole local days regardless of the time of day', () => {
    // 23:59 to 00:01 is two minutes apart but one calendar day.
    expect(localDayDiff(new Date(2026, 8, 11, 23, 59), new Date(2026, 8, 12, 0, 1))).toBe(1);
    // 00:01 to 23:59 on one day is nearly 24 hours apart but zero days.
    expect(localDayDiff(new Date(2026, 8, 12, 0, 1), new Date(2026, 8, 12, 23, 59))).toBe(0);
  });

  it('is signed and spans months', () => {
    expect(localDayDiff(new Date(2026, 8, 12, 9, 0), new Date(2026, 8, 10, 9, 0))).toBe(-2);
    expect(localDayDiff(new Date(2026, 7, 30, 9, 0), new Date(2026, 8, 2, 9, 0))).toBe(3);
  });

  it('is NaN when either side is unparseable', () => {
    expect(localDayDiff('nope', new Date(2026, 8, 12))).toBeNaN();
  });
});

describe('startOfLocalDay', () => {
  it('returns local midnight of the same calendar day', () => {
    const start = startOfLocalDay(new Date(2026, 8, 12, 17, 45, 30, 250));
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);
    expect(localDayKey(start)).toBe('2026-09-12');
  });
});
