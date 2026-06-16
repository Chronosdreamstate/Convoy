/**
 * DrivingModeService — auto-activates Driving Mode on BT/CarPlay connect.
 * Requirements: 28.1–28.6
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DrivingModeListener = (active: boolean) => void;

export interface IBluetoothProvider {
  /** Subscribe to vehicle BT connect/disconnect events. Returns unsubscribe fn. */
  onVehicleConnectionChange(cb: (connected: boolean) => void): () => void;
}

export interface ICarPlayProvider {
  /** Subscribe to CarPlay session events. Returns unsubscribe fn. */
  onCarPlaySessionChange(cb: (connected: boolean) => void): () => void;
}

// ---------------------------------------------------------------------------
// Pure helper — exported for property testing
// ---------------------------------------------------------------------------

/**
 * Property 50: Driving Mode should be active if BT OR CarPlay is connected.
 * Deactivates only when BOTH are inactive (Req 28.6).
 */
export function computeDrivingModeActive(btConnected: boolean, carPlayConnected: boolean): boolean {
  return btConnected || carPlayConnected;
}

// ---------------------------------------------------------------------------
// DrivingModeService
// ---------------------------------------------------------------------------

export class DrivingModeService {
  private _btConnected = false;
  private _carPlayConnected = false;
  private _manualActive: boolean | null = null; // null = auto mode
  private listeners: Set<DrivingModeListener> = new Set();
  private unsubBt: (() => void) | null = null;
  private unsubCarPlay: (() => void) | null = null;

  constructor(
    private readonly bt: IBluetoothProvider,
    private readonly carPlay: ICarPlayProvider,
  ) {}

  /** Begin watching BT and CarPlay events (Req 28.1). */
  start(): void {
    this.unsubBt = this.bt.onVehicleConnectionChange((connected) => {
      this._btConnected = connected;
      this.notify();
    });
    this.unsubCarPlay = this.carPlay.onCarPlaySessionChange((connected) => {
      this._carPlayConnected = connected;
      this.notify();
    });
  }

  stop(): void {
    this.unsubBt?.();
    this.unsubCarPlay?.();
  }

  /** Manual override from UI (Req 28.4, 28.5). Pass null to return to auto mode. */
  setManualActive(value: boolean | null): void {
    this._manualActive = value;
    this.notify();
  }

  get isActive(): boolean {
    if (this._manualActive !== null) return this._manualActive;
    return computeDrivingModeActive(this._btConnected, this._carPlayConnected);
  }

  subscribe(listener: DrivingModeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const active = this.isActive;
    this.listeners.forEach((l) => l(active));
  }
}
