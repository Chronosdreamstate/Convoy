/**
 * sharedMotionState → motion store bridge (Req 30, feeding Req 33/34).
 *
 * The state-machine mechanics (threshold, hysteresis) are property-tested in
 * motion.property.test.ts. This file covers the contract the shared instance
 * adds on top: every feeder that calls `sharedMotionState.update(speedKph)`
 * (LocationService's pipeline, or a screen with its own location watch) drives
 * the one `useMotionStore().isInMotion` flag that all Req 33/34 consumers read.
 */

import { sharedMotionState } from './MotionStateService';
import { useMotionStore } from '../stores/motionStore';

/** ~8 km/h — above the 5 mph in-motion threshold. */
const MOVING_KPH = 30;
const PARKED_KPH = 0;

/** Drives the shared singleton back to 'parked' so each test starts clean. */
function forceParked() {
  for (let i = 0; i < 3; i++) sharedMotionState.update(PARKED_KPH);
}

beforeEach(() => {
  forceParked();
  useMotionStore.setState({ isInMotion: false });
});

describe('sharedMotionState store bridge', () => {
  it('flips the shared store to in-motion on a fast sample', () => {
    expect(useMotionStore.getState().isInMotion).toBe(false);

    sharedMotionState.update(MOVING_KPH);

    expect(sharedMotionState.state).toBe('in_motion');
    expect(useMotionStore.getState().isInMotion).toBe(true);
  });

  it('holds in-motion through brief slow samples (hysteresis), then parks after three', () => {
    sharedMotionState.update(MOVING_KPH);

    // One or two slow samples are not enough — a stoplight must not un-cap lists.
    sharedMotionState.update(PARKED_KPH);
    sharedMotionState.update(PARKED_KPH);
    expect(useMotionStore.getState().isInMotion).toBe(true);

    sharedMotionState.update(PARKED_KPH);
    expect(useMotionStore.getState().isInMotion).toBe(false);
  });

  it('stays parked (no store churn) while samples remain slow', () => {
    const writes: boolean[] = [];
    const unsubscribe = useMotionStore.subscribe((s) => writes.push(s.isInMotion));

    sharedMotionState.update(PARKED_KPH);
    sharedMotionState.update(PARKED_KPH);

    // The bridge only writes on state *transitions* — parked → parked is silent.
    expect(writes).toHaveLength(0);
    expect(useMotionStore.getState().isInMotion).toBe(false);
    unsubscribe();
  });
});

describe('reset() — GPS feed torn down mid-motion', () => {
  it('parks immediately and clears the store, without waiting for three slow samples', () => {
    sharedMotionState.update(MOVING_KPH);
    expect(useMotionStore.getState().isInMotion).toBe(true);

    // LocationService.stopTracking / sign-out call this: no further samples are
    // coming, so the hysteresis could never settle on its own and every Req
    // 33/34 consumer would stay capped/blocked for the rest of the session.
    sharedMotionState.reset();

    expect(sharedMotionState.state).toBe('parked');
    expect(useMotionStore.getState().isInMotion).toBe(false);
  });

  it('is silent when already parked', () => {
    const writes: boolean[] = [];
    const unsubscribe = useMotionStore.subscribe((s) => writes.push(s.isInMotion));

    sharedMotionState.reset();

    expect(writes).toHaveLength(0);
    unsubscribe();
  });

  it('clears the below-threshold streak so the next drive parks on a full three samples', () => {
    sharedMotionState.update(MOVING_KPH);
    sharedMotionState.update(PARKED_KPH);
    sharedMotionState.update(PARKED_KPH); // 2 of 3 slow samples banked
    sharedMotionState.reset();

    // New drive: one slow sample must NOT immediately re-park via a stale count.
    sharedMotionState.update(MOVING_KPH);
    sharedMotionState.update(PARKED_KPH);
    expect(useMotionStore.getState().isInMotion).toBe(true);
  });
});
