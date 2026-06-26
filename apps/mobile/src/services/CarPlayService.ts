/**
 * CarPlayService — manages the Apple CarPlay session lifecycle and state hand-off.
 * Requirements: 13.1–13.7, 28.1, 31.3, 35.1–35.2
 *
 * The native CPInterfaceController, CPMapTemplate, CPListTemplate, CPAlertTemplate,
 * and CPGridTemplate are implemented in the ConvoyCarPlay Xcode target (Swift).
 * This service is the TypeScript bridge that:
 *   1. Receives CarPlay session lifecycle events via a native module.
 *   2. Syncs Zustand state to the native layer via UserDefaults / AppGroup.
 *   3. Notifies DrivingModeService of connect/disconnect.
 */

import { EmitterSubscription, NativeEventEmitter, NativeModules, Platform } from 'react-native';

// ---------------------------------------------------------------------------
// Native module interface (implemented in Swift)
// ---------------------------------------------------------------------------

interface IConvoyCarPlayModule {
  /** Push current app state to the CarPlay native layer via AppGroup. */
  syncState(state: CarPlayState): void;
  /** Returns true if a CarPlay session is currently active. */
  isSessionActive(): Promise<boolean>;
}

export interface CarPlayState {
  groupId: string | null;
  memberCount: number;
  routeActive: boolean;
  pttChannelId: string | null;
  myCallsign: string;
  /** Human-readable name of the active group shown on the CarPlay map template header. */
  activeGroupName: string | null;
  /** Number of open/nearby groups available to join — shown on the CarPlay list template. */
  nearbyGroupCount: number;
  /** Lifecycle phase of the convoy — used by native to switch between map/list/idle templates. */
  convoyStatus: 'idle' | 'active' | 'ending';
  /** Callsign of the member currently transmitting on PTT — shown as a waveform banner. */
  transmittingMemberCallsign: string | null;
  /** Display name of the next route waypoint — shown in the native navigation strip. */
  nextWaypointName: string | null;
  /** ETA to next waypoint in minutes — shown alongside waypoint name. */
  nextWaypointEtaMinutes: number | null;
}

// ---------------------------------------------------------------------------
// Instrument Cluster interface (CarPlay Ultra / dual-display vehicles)
// ---------------------------------------------------------------------------

export interface ICarPlayInstrumentCluster {
  /** Display the current road speed limit on the instrument cluster. */
  showSpeedLimit(limitKph: number): void;
  /** Display the next convoy waypoint name and distance to it. */
  showNextWaypoint(name: string, distanceKm: number): void;
  /** Display this vehicle's position within the convoy and total convoy size. */
  showConvoyPosition(myPosition: number, total: number): void;
  /** Clear all convoy data from the instrument cluster display. */
  clear(): void;
}

/** No-op implementation — used in tests and on non-Ultra (single-display) hardware. */
export class NoopInstrumentCluster implements ICarPlayInstrumentCluster {
  showSpeedLimit(_limitKph: number): void {}
  showNextWaypoint(_name: string, _distanceKm: number): void {}
  showConvoyPosition(_myPosition: number, _total: number): void {}
  clear(): void {}
}

// ---------------------------------------------------------------------------
// CarPlayService
// ---------------------------------------------------------------------------

type CarPlayListener = (connected: boolean) => void;

function statesEqual(a: CarPlayState, b: CarPlayState): boolean {
  return (
    a.groupId === b.groupId &&
    a.memberCount === b.memberCount &&
    a.routeActive === b.routeActive &&
    a.pttChannelId === b.pttChannelId &&
    a.myCallsign === b.myCallsign &&
    a.activeGroupName === b.activeGroupName &&
    a.nearbyGroupCount === b.nearbyGroupCount &&
    a.convoyStatus === b.convoyStatus &&
    a.transmittingMemberCallsign === b.transmittingMemberCallsign &&
    a.nextWaypointName === b.nextWaypointName &&
    a.nextWaypointEtaMinutes === b.nextWaypointEtaMinutes
  );
}

export class CarPlayService {
  private module: IConvoyCarPlayModule | null = null;
  private emitter: NativeEventEmitter | null = null;
  private listeners: Set<CarPlayListener> = new Set();
  private connectSub: EmitterSubscription | null = null;
  private disconnectSub: EmitterSubscription | null = null;
  private stateRequestSub: EmitterSubscription | null = null;
  private currentState: CarPlayState | null = null;
  private stopFn: (() => void) | null = null;
  private instrumentCluster: ICarPlayInstrumentCluster | null = null;

  constructor(instrumentCluster?: ICarPlayInstrumentCluster) {
    this.instrumentCluster = instrumentCluster ?? null;
    if (Platform.OS === 'ios' && NativeModules.ConvoyCarPlay) {
      this.module = NativeModules.ConvoyCarPlay as IConvoyCarPlayModule;
      this.emitter = new NativeEventEmitter(NativeModules.ConvoyCarPlay);
    }
  }

  /** Wire lifecycle events — returns an unsubscribe fn (Req 13.7, 28.1). */
  start(): () => void {
    if (!this.emitter) return () => {};

    // Remove previous subscriptions before re-registering to prevent accumulation
    this.connectSub?.remove();
    this.disconnectSub?.remove();
    this.stateRequestSub?.remove();

    try {
      this.connectSub = this.emitter.addListener('CarPlayDidConnect', () => {
        this.listeners.forEach((l) => l(true));
      });
      this.disconnectSub = this.emitter.addListener('CarPlayDidDisconnect', () => {
        this.listeners.forEach((l) => l(false));
      });
      // Native layer requests a full resync (e.g. after memory pressure / template reload)
      this.stateRequestSub = this.emitter.addListener('CarPlayStateRequest', () => {
        if (this.currentState) {
          this.module?.syncState(this.currentState);
        }
      });
    } catch (err) {
      console.warn('[CarPlayService] Failed to register native listeners:', err);
    }

    const stop = () => {
      this.connectSub?.remove();
      this.connectSub = null;
      this.disconnectSub?.remove();
      this.disconnectSub = null;
      this.stateRequestSub?.remove();
      this.stateRequestSub = null;
    };
    this.stopFn = stop;
    return stop;
  }

  /** Push current app state to the CarPlay native UI (Req 13.1–13.5). */
  syncState(state: CarPlayState): void {
    this.currentState = state;
    this.module?.syncState(state);
  }

  /** Only syncs to native if state has actually changed — avoids redundant IPC (Req 35.1). */
  syncStateIfChanged(state: CarPlayState): void {
    if (this.currentState && statesEqual(this.currentState, state)) return;
    this.syncState(state);
    this.syncInstrumentCluster();
  }

  /**
   * Pushes current state to the instrument cluster display (CarPlay Ultra / dual-display).
   * Clears the cluster first, then repopulates with the latest state values.
   * A no-op when no cluster was provided to the constructor.
   */
  syncInstrumentCluster(): void {
    if (!this.instrumentCluster || !this.currentState) return;
    const s = this.currentState;
    this.instrumentCluster.clear();
    this.instrumentCluster.showSpeedLimit(0);
    this.instrumentCluster.showNextWaypoint(s.nextWaypointName ?? '', 0);
    this.instrumentCluster.showConvoyPosition(1, s.memberCount);
  }

  /** Returns the last synced state, or null if syncState has never been called. */
  getState(): CarPlayState | null {
    return this.currentState;
  }

  /** Update the PTT transmitting callsign without requiring a full state rebuild. */
  setTransmitting(callsign: string | null): void {
    if (!this.currentState) return;
    const next: CarPlayState = { ...this.currentState, transmittingMemberCallsign: callsign };
    this.syncStateIfChanged(next);
  }

  /** Subscribe to session changes — used by DrivingModeService. */
  onCarPlaySessionChange(cb: CarPlayListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async isActive(): Promise<boolean> {
    if (!this.module) return false;
    return this.module.isSessionActive();
  }

  /** Tear down all subscriptions and reset state. Call on app logout or unmount. */
  destroy(): void {
    this.stopFn?.();
    this.stopFn = null;
    this.listeners.clear();
    this.currentState = null;
  }
}

export const carPlayService = new CarPlayService();
