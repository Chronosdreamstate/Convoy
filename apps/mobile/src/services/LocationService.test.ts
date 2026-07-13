/**
 * LocationService static pipeline → shared motion feed (Req 33/34 supply).
 *
 * Motion_State used to be derived only inside MapScreen's LocationService
 * callback, which left `useMotionStore().isInMotion` frozen at false — and
 * every in-motion list cap / flow guard inert — unless MapScreen had mounted
 * that session. These tests pin the fix: the shared pipeline itself feeds
 * `sharedMotionState` on every delivered fix (watch callback AND the 3 s
 * heartbeat), with or without a screen callback registered, while the screen
 * callback path MapScreen relies on keeps receiving identical fixes.
 *
 * The emit-throttling / DB-caching instance behaviour is property-tested in
 * LocationService.property.test.ts.
 */

import * as Location from 'expo-location';
import { LocationService } from './LocationService';
import { sharedMotionState } from './MotionStateService';
import { useMotionStore } from '../stores/motionStore';

jest.mock('expo-location', () => ({
  requestBackgroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  requestForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  watchPositionAsync: jest.fn(),
  Accuracy: { High: 4, Balanced: 3 },
}));

type RawFix = {
  coords: { latitude: number; longitude: number; heading: number | null; speed: number | null };
  timestamp: number;
};

// Captured from the watchPositionAsync mock — lets tests emit GPS fixes.
let emitGpsFix: (fix: RawFix) => void;

/** speed is in m/s (expo-location's unit); 10 m/s = 36 km/h — well in motion. */
function rawFix(speedMps: number): RawFix {
  return {
    coords: { latitude: 37.1, longitude: -122.2, heading: 90, speed: speedMps },
    timestamp: Date.now(),
  };
}

beforeEach(() => {
  (Location.watchPositionAsync as jest.Mock).mockImplementation(
    async (_opts: unknown, cb: (fix: RawFix) => void) => {
      emitGpsFix = cb;
      return { remove: jest.fn() };
    },
  );
  // The shared motion singleton persists across tests — drive it back to
  // parked (3 slow samples satisfy the hysteresis) so each test starts clean.
  for (let i = 0; i < 3; i++) sharedMotionState.update(0);
  useMotionStore.setState({ isInMotion: false });
});

afterEach(async () => {
  await LocationService.stopTracking();
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe('LocationService shared motion feed', () => {
  it('feeds the motion store from GPS fixes with NO screen callback registered', async () => {
    await LocationService.startTracking();

    emitGpsFix(rawFix(10)); // 36 km/h

    // No MapScreen (or any screen) mounted — the cap flag must still engage.
    expect(useMotionStore.getState().isInMotion).toBe(true);
  });

  it('returns to parked after three consecutive slow fixes (hysteresis intact)', async () => {
    await LocationService.startTracking();

    emitGpsFix(rawFix(10));
    emitGpsFix(rawFix(0));
    emitGpsFix(rawFix(0));
    expect(useMotionStore.getState().isInMotion).toBe(true); // 2 slow samples — not yet

    emitGpsFix(rawFix(0));
    expect(useMotionStore.getState().isInMotion).toBe(false);
  });

  it('still delivers fixes to the registered screen callback (MapScreen path unchanged)', async () => {
    const received: Array<{ lat: number; lng: number; heading: number; speedKph: number; ts: number }> = [];
    LocationService.setCallback((fix) => received.push(fix));
    await LocationService.startTracking();

    emitGpsFix(rawFix(10));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ lat: 37.1, lng: -122.2, heading: 90, speedKph: 36 });
    // And the shared feed saw the same sample — one source, two consumers.
    expect(useMotionStore.getState().isInMotion).toBe(true);
  });

  it('keeps sampling via the 3 s heartbeat so parked can settle without a screen callback', async () => {
    jest.useFakeTimers();
    await LocationService.startTracking();

    emitGpsFix(rawFix(10)); // in motion
    emitGpsFix(rawFix(0));  // slow sample 1 of 3 — car has stopped
    expect(useMotionStore.getState().isInMotion).toBe(true);

    // No further GPS callbacks (iOS stops firing when stationary) and no
    // screen mounted — the heartbeat re-delivers the last (slow) fix every
    // 3 s, so two beats complete the hysteresis and the store un-caps.
    jest.advanceTimersByTime(3_000);
    expect(useMotionStore.getState().isInMotion).toBe(true); // slow sample 2 of 3

    jest.advanceTimersByTime(3_000);
    expect(useMotionStore.getState().isInMotion).toBe(false); // slow sample 3 — parked
  });
});
