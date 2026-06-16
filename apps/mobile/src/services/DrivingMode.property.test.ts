/**
 * Property tests for driving mode and motion state.
 * Property 50: Driving Mode deactivates when both triggers are absent (Req 28.6)
 */

import fc from 'fast-check';
import { computeDrivingModeActive } from './DrivingModeService';
import { deriveMotionState } from './MotionStateService';

// ---------------------------------------------------------------------------
// Property 50: Driving Mode deactivates when both triggers are absent
// ---------------------------------------------------------------------------

describe('Property 50: Driving Mode deactivates when both triggers are absent', () => {
  test('P50.1: active when only BT is connected', () => {
    expect(computeDrivingModeActive(true, false)).toBe(true);
  });

  test('P50.2: active when only CarPlay is connected', () => {
    expect(computeDrivingModeActive(false, true)).toBe(true);
  });

  test('P50.3: active when both are connected', () => {
    expect(computeDrivingModeActive(true, true)).toBe(true);
  });

  test('P50.4: inactive when both are disconnected', () => {
    expect(computeDrivingModeActive(false, false)).toBe(false);
  });

  test('P50.5: result is exactly the OR of both inputs', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (bt, cp) => {
        expect(computeDrivingModeActive(bt, cp)).toBe(bt || cp);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Motion state derivation (Req 30.1–30.3)
// ---------------------------------------------------------------------------

describe('Motion state is derived from GPS speed only', () => {
  const THRESHOLD_KPH = 5 * 1.60934;

  test('GPS speed above 5 mph → in_motion', () => {
    expect(deriveMotionState(THRESHOLD_KPH + 0.1)).toBe('in_motion');
  });

  test('GPS speed at exactly 5 mph → parked', () => {
    expect(deriveMotionState(THRESHOLD_KPH)).toBe('parked');
  });

  test('GPS speed 0 → parked', () => {
    expect(deriveMotionState(0)).toBe('parked');
  });

  test('result is always one of two valid states', () => {
    fc.assert(
      fc.property(fc.float({ min: 0, max: 300, noNaN: true }), (speedKph) => {
        const state = deriveMotionState(speedKph);
        expect(['parked', 'in_motion']).toContain(state);
      }),
    );
  });

  test('high speed always yields in_motion', () => {
    fc.assert(
      fc.property(fc.float({ min: Math.fround(THRESHOLD_KPH + 0.01), max: Math.fround(300), noNaN: true }), (speedKph) => {
        expect(deriveMotionState(speedKph)).toBe('in_motion');
      }),
    );
  });

  test('low speed always yields parked', () => {
    fc.assert(
      fc.property(fc.float({ min: Math.fround(0), max: Math.fround(THRESHOLD_KPH), noNaN: true }), (speedKph) => {
        expect(deriveMotionState(speedKph)).toBe('parked');
      }),
    );
  });
});
