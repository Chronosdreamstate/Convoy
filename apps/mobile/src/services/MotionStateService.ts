/**
 * MotionStateService — derives Motion_State from GPS speed.
 * Requirements: 30.1–30.4
 */

import { useMotionStore } from '../stores/motionStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MotionState = 'parked' | 'in_motion';

export type MotionStateListener = (state: MotionState) => void;

// ---------------------------------------------------------------------------
// Pure helper — exported for property testing
// ---------------------------------------------------------------------------

/** Speed threshold: > 5 mph → in_motion; ≤ 5 mph → parked. */
const MOTION_THRESHOLD_KPH = 5 * 1.60934; // 5 mph in km/h ≈ 8.047

/**
 * Derives Motion_State purely from GPS speed in km/h.
 * Does NOT use accelerometer data (Req 30.1).
 */
export function deriveMotionState(speedKph: number): MotionState {
  return speedKph > MOTION_THRESHOLD_KPH ? 'in_motion' : 'parked';
}

// ---------------------------------------------------------------------------
// MotionStateService
// ---------------------------------------------------------------------------

export class MotionStateService {
  private _state: MotionState = 'parked';
  private listeners: Set<MotionStateListener> = new Set();
  private belowThresholdCount = 0;
  private static readonly PARKED_SAMPLES_REQUIRED = 3;

  /** Feed each GPS speed reading — call from LocationService. */
  update(speedKph: number): void {
    const derived = deriveMotionState(speedKph);

    if (derived === 'in_motion') {
      this.belowThresholdCount = 0;
      if (this._state !== 'in_motion') {
        this._state = 'in_motion';
        this.listeners.forEach((l) => l('in_motion'));
      }
    } else {
      this.belowThresholdCount++;
      if (
        this._state === 'in_motion' &&
        this.belowThresholdCount >= MotionStateService.PARKED_SAMPLES_REQUIRED
      ) {
        this._state = 'parked';
        this.belowThresholdCount = 0;
        this.listeners.forEach((l) => l('parked'));
      }
    }
  }

  get state(): MotionState {
    return this._state;
  }

  /**
   * Force the machine back to 'parked' and notify listeners.
   *
   * The hysteresis in update() only parks after three consecutive slow
   * samples, so when the GPS feed STOPS while in motion (leaving a convoy /
   * signing out mid-drive) the state would otherwise stay 'in_motion'
   * indefinitely — with no further samples coming, nothing could ever clear
   * it. Everything behind `useMotionStore().isInMotion` (useMotionGuard's
   * "can't do this while driving" blocks, MotionAwareList's Req 33 caps) then
   * stayed engaged for the rest of the app session. Call this from whatever
   * tears the feed down.
   */
  reset(): void {
    this.belowThresholdCount = 0;
    if (this._state === 'parked') return;
    this._state = 'parked';
    this.listeners.forEach((l) => l('parked'));
  }

  subscribe(listener: MotionStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

// ---------------------------------------------------------------------------
// Shared app-wide instance — feeds `useMotionStore().isInMotion`
// ---------------------------------------------------------------------------

/**
 * The app-wide MotionStateService instance behind the shared motion store
 * (`useMotionStore().isInMotion` — what every Req 33/34 consumer reads).
 * LocationService feeds it from the shared GPS pipeline on every fix, so
 * motion state stays live whenever location updates flow — no particular
 * screen has to be mounted for the in-motion cap / guard to engage.
 *
 * Screens with their own location watch outside LocationService (e.g.
 * IdleMapScreen) should call `sharedMotionState.update(speedKph)` from their
 * watch callback rather than standing up another instance, so every consumer
 * agrees on one hysteresis-debounced state.
 */
export const sharedMotionState = new MotionStateService();
sharedMotionState.subscribe((state) => {
  useMotionStore.getState().setIsInMotion(state === 'in_motion');
});
