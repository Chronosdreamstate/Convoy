/**
 * The upcoming-event countdown on ConvoyScreen.
 *
 * The digit row it feeds carries no unit labels — the 'HH'/'MM'/'SS' strings
 * beside each value are React keys and are never rendered — so every number in
 * it is read as hours : minutes : seconds. Hours was the largest unit, so an
 * event three weeks out rendered "504 : 12 : 03": a three-digit number in a
 * slot styled for two, and a figure no one reads as "21 days".
 *
 * Adding a days slot would not have fixed it — unlabelled, "21 : 00 : 12"
 * reads as 21 hours. So anything two days out or more is spelled out in words,
 * which also keeps every value that does reach the digit row under 48.
 */

import {
  computeEventCountdown,
  eventCountdownDisplay,
} from './ConvoyScreen';

const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);

/** `hours` from now, as the ISO string the API sends. */
function inHours(hours: number): string {
  return new Date(NOW + hours * 3_600_000).toISOString();
}

describe('computeEventCountdown', () => {
  it('returns null once the event has started', () => {
    expect(computeEventCountdown(inHours(-0.001), NOW)).toBeNull();
    expect(computeEventCountdown(new Date(NOW).toISOString(), NOW)).toBeNull();
  });

  it('returns null for an unparseable date rather than NaN fields', () => {
    // The old inline version compared NaN <= 0 (false) and populated the
    // countdown with NaN, rendering "NaN : NaN : NaN".
    expect(computeEventCountdown('not-a-date', NOW)).toBeNull();
  });

  it('splits days out instead of rolling everything into hours', () => {
    // 21 days, 12 hours, 30 minutes, 15 seconds.
    const at = new Date(NOW + 21 * 86_400_000 + 12 * 3_600_000 + 30 * 60_000 + 15_000).toISOString();
    expect(computeEventCountdown(at, NOW)).toEqual({
      days: 21,
      hours: 12,
      minutes: 30,
      seconds: 15,
    });
  });
});

describe('eventCountdownDisplay', () => {
  it('spells out an event three weeks away instead of showing 504 in an hours slot', () => {
    const countdown = computeEventCountdown(inHours(21 * 24), NOW);
    const display = eventCountdownDisplay(countdown);

    expect(display).toEqual({ kind: 'far', days: 21 });

    // The regression this guards: hours as the largest unit.
    if (display.kind === 'clock') throw new Error('unreachable');
    expect(JSON.stringify(display)).not.toContain('504');
  });

  it('still counts down in digits for an event tomorrow', () => {
    const display = eventCountdownDisplay(computeEventCountdown(inHours(30), NOW));
    // 30 hours is over a day but under the two-day threshold, so it stays a
    // clock — and reports 30 TOTAL hours, not 6 hours past a day boundary.
    expect(display).toEqual({ kind: 'clock', hours: 30, minutes: 0, seconds: 0 });
  });

  it('keeps every digit-row value inside its two-digit slot', () => {
    // The threshold's real job: whatever reaches the clock must fit in 2 chars.
    for (const hours of [0.01, 1, 12, 23.5, 36, 47.99]) {
      const display = eventCountdownDisplay(computeEventCountdown(inHours(hours), NOW));
      expect(display.kind).toBe('clock');
      if (display.kind !== 'clock') continue;
      expect(String(display.hours).length).toBeLessThanOrEqual(2);
    }
  });

  it('switches to words at exactly two days', () => {
    expect(eventCountdownDisplay(computeEventCountdown(inHours(47.9), NOW)).kind).toBe('clock');
    expect(eventCountdownDisplay(computeEventCountdown(inHours(48), NOW)).kind).toBe('far');
  });

  it('renders nothing when there is no countdown', () => {
    expect(eventCountdownDisplay(null)).toEqual({ kind: 'none' });
  });
});
