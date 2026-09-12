/**
 * Local-calendar date helpers.
 *
 * Everything the app SHOWS is rendered in the device's timezone (every label
 * goes through toLocaleDateString / toLocaleTimeString), so everything the app
 * GROUPS by a day has to be keyed in that same zone. `toISOString().slice(0,10)`
 * and `age < 86_400_000` are both UTC/rolling-window answers that silently
 * disagree with the local labels for anyone whose offset isn't zero — that is
 * exactly how Drive History once grew two identical date headers for a single
 * local day.
 *
 * Everything here is deliberately built from the LOCAL field accessors
 * (getFullYear/getMonth/getDate) and from setDate() rather than ±86400000, so a
 * 23- or 25-hour DST day still counts as exactly one day.
 */

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Local midnight at the start of the calendar day `value` falls on. */
export function startOfLocalDay(value: Date | string | number): Date {
  const d = toDate(value);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * `value` shifted by `days` LOCAL calendar days, keeping the time of day.
 * Uses setDate (not ±86400000) so it can't skip or repeat a day across a DST
 * transition.
 */
export function addLocalDays(value: Date | string | number, days: number): Date {
  const d = toDate(value);
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + days);
  return out;
}

/** The LOCAL calendar day `value` falls on, as YYYY-MM-DD. */
export function localDayKey(value: Date | string | number): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Whole LOCAL calendar days between two instants (`to` minus `from`).
 * Compares local midnights and rounds, so a DST day (23h or 25h) still counts
 * as one. Returns NaN if either side is unparseable.
 */
export function localDayDiff(from: Date | string | number, to: Date | string | number): number {
  const a = toDate(from);
  const b = toDate(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return NaN;
  return Math.round(
    (startOfLocalDay(b).getTime() - startOfLocalDay(a).getTime()) / 86_400_000,
  );
}
