/**
 * Unit-aware display formatters.
 *
 * Every screen that prints a distance or a speed must route it through here
 * with the user's Settings > Map > Distance Units preference (default:
 * `miles`). Screens that hard-coded "km" / "km/h" showed one drive as
 * "12.4 mi" in Drive History and "20.0 km" in Route Replay — the same number
 * wearing two different labels, which is worse than showing no label at all.
 */

import type { DistanceUnit } from '../stores/settingsStore';

export const METERS_PER_MILE = 1609.344;
export const KM_PER_MILE = 1.609344;
export const FEET_PER_METER = 3.28084;

/**
 * Distance in metres → a short display string in the user's preferred unit.
 * Sub-0.1 mi / sub-1 km values fall back to feet / metres so short hops don't
 * all collapse to "0.0 mi".
 */
export function formatDistanceM(metres: number, unit: DistanceUnit): string {
  if (!Number.isFinite(metres)) return '—';
  if (unit === 'miles') {
    const miles = metres / METERS_PER_MILE;
    if (miles >= 0.1) return `${miles.toFixed(1)} mi`;
    return `${Math.round(metres * FEET_PER_METER)} ft`;
  }
  if (metres >= 1000) return `${(metres / 1000).toFixed(1)} km`;
  return `${Math.round(metres)} m`;
}

/** Distance already expressed in kilometres (server aggregates) → display string. */
export function formatDistanceKm(km: number, unit: DistanceUnit): string {
  if (!Number.isFinite(km)) return '—';
  if (unit === 'miles') return `${Math.round(km / KM_PER_MILE).toLocaleString()} mi`;
  return `${Math.round(km).toLocaleString()} km`;
}

/** Speed in km/h (the server's storage unit) → display string in the user's unit. */
export function formatSpeedKph(kph: number | null | undefined, unit: DistanceUnit): string {
  if (kph == null || !Number.isFinite(kph)) return '—';
  if (unit === 'miles') return `${Math.round(kph / KM_PER_MILE)} mph`;
  return `${Math.round(kph)} km/h`;
}

/** Bare speed unit label, for places that lay out the number separately. */
export function speedUnitLabel(unit: DistanceUnit): string {
  return unit === 'miles' ? 'mph' : 'km/h';
}
