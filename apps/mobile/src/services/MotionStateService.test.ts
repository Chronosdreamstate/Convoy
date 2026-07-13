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
