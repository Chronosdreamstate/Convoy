/**
 * MotionStateService — derives Motion_State from GPS speed.
 * Requirements: 30.1–30.4
 */

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

  /** Feed each GPS speed reading — call from LocationService. */
  update(speedKph: number): void {
    const next = deriveMotionState(speedKph);
    if (next !== this._state) {
      this._state = next;
      this.listeners.forEach((l) => l(next));
    }
  }

  get state(): MotionState {
    return this._state;
  }

  subscribe(listener: MotionStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
