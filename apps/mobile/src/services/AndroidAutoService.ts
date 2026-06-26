/**
 * AndroidAutoService — manages the Android Auto session lifecycle and state hand-off.
 * Requirements: 13.6–13.7, 28.1, 31.3, 35.3–35.4
 *
 * The CarAppService screens (NavigationScreen, MemberListScreen, HazardScreen, PTTScreen)
 * are implemented natively in Kotlin using the AndroidX Car App Library.
 * This service is the TypeScript bridge that:
 *   1. Receives session lifecycle events from the native CarAppService via a bound Messenger.
 *   2. Syncs Zustand state to the native layer via a local broadcast Intent bus.
 *   3. Notifies DrivingModeService of connect/disconnect.
 */

import { DeviceEventEmitter, EmitterSubscription, NativeModules, Platform } from 'react-native';

// ---------------------------------------------------------------------------
// Native module interface (implemented in Kotlin)
// ---------------------------------------------------------------------------

interface IConvoyAndroidAutoModule {
  /** Push current state to CarAppService via local broadcast. */
  syncState(state: AndroidAutoState): void;
  isSessionActive(): Promise<boolean>;
}

export interface AndroidAutoState {
  groupId: string | null;
  memberCount: number;
  routeActive: boolean;
  pttChannelId: string | null;
  myCallsign: string;
  /** Human-readable name of the active group shown on the Auto navigation screen header. */
  activeGroupName: string | null;
  /** Number of open/nearby groups available to join — shown on the Auto list screen. */
  nearbyGroupCount: number;
  /** Lifecycle phase of the convoy — used by Kotlin screens to switch between idle/active/ending UI. */
  convoyStatus: 'idle' | 'active' | 'ending';
  /** Callsign of the member currently transmitting on PTT — shown as a waveform banner. */
  transmittingMemberCallsign: string | null;
  /** Display name of the next route waypoint. */
  nextWaypointName: string | null;
  /** ETA to next waypoint in minutes. */
  nextWaypointEtaMinutes: number | null;
}

// ---------------------------------------------------------------------------
// AndroidAutoService
// ---------------------------------------------------------------------------

type AutoListener = (connected: boolean) => void;

export class AndroidAutoService {
  private module: IConvoyAndroidAutoModule | null = null;
  private listeners: Set<AutoListener> = new Set();
  private connectSub: EmitterSubscription | null = null;
  private disconnectSub: EmitterSubscription | null = null;
  private connected = false;
  private lastState: AndroidAutoState | null = null;

  constructor() {
    if (Platform.OS === 'android' && NativeModules.ConvoyAndroidAuto) {
      this.module = NativeModules.ConvoyAndroidAuto as IConvoyAndroidAutoModule;
    }
  }

  /**
   * Wire lifecycle events from the native CarAppService.
   * Removes any previously registered subscriptions before re-registering to prevent
   * accumulation if start() is called more than once (Req 13.7, 28.1).
   * @returns An unsubscribe function that removes the event listeners.
   */
  start(): () => void {
    if (Platform.OS !== 'android') return () => {};

    // Remove stale subscriptions before re-registering
    this.connectSub?.remove();
    this.disconnectSub?.remove();

    this.connectSub = DeviceEventEmitter.addListener('AndroidAutoDidConnect', () => {
      this.connected = true;
      this.listeners.forEach((l) => l(true));
    });
    this.disconnectSub = DeviceEventEmitter.addListener('AndroidAutoDidDisconnect', () => {
      this.connected = false;
      this.lastState = null; // reset cache so next sync always pushes fresh state
      this.listeners.forEach((l) => l(false));
    });

    return () => {
      this.connectSub?.remove();
      this.connectSub = null;
      this.disconnectSub?.remove();
      this.disconnectSub = null;
    };
  }

  /**
   * Push current app state to Android Auto screens only if it has changed (Req 13.6).
   * Avoids redundant native calls when the same state is broadcast repeatedly.
   */
  syncStateIfChanged(state: AndroidAutoState): void {
    if (
      this.lastState !== null &&
      this.lastState.groupId === state.groupId &&
      this.lastState.memberCount === state.memberCount &&
      this.lastState.routeActive === state.routeActive &&
      this.lastState.pttChannelId === state.pttChannelId &&
      this.lastState.myCallsign === state.myCallsign &&
      this.lastState.activeGroupName === state.activeGroupName &&
      this.lastState.nearbyGroupCount === state.nearbyGroupCount &&
      this.lastState.convoyStatus === state.convoyStatus &&
      this.lastState.transmittingMemberCallsign === state.transmittingMemberCallsign &&
      this.lastState.nextWaypointName === state.nextWaypointName &&
      this.lastState.nextWaypointEtaMinutes === state.nextWaypointEtaMinutes
    ) {
      return;
    }
    this.lastState = state;
    this.module?.syncState(state);
  }

  /**
   * Push current app state unconditionally. Use syncStateIfChanged() in hot paths
   * to avoid unnecessary bridge calls (Req 13.6).
   */
  syncState(state: AndroidAutoState): void {
    this.lastState = state;
    this.module?.syncState(state);
  }

  /**
   * Subscribe to Android Auto session connect/disconnect events.
   * Used by DrivingModeService to switch into driving mode.
   * @returns An unsubscribe function.
   */
  onCarPlaySessionChange(cb: AutoListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Synchronous connection state — safe to call in render or guards without awaiting.
   * Reflects the most recent connect/disconnect event received from the native layer.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /** Update the PTT transmitting callsign without requiring a full state rebuild. */
  setTransmitting(callsign: string | null): void {
    if (!this.lastState) return;
    const next: AndroidAutoState = { ...this.lastState, transmittingMemberCallsign: callsign };
    this.syncStateIfChanged(next);
  }

  /**
   * Async session check via native module — source of truth for initial state before
   * the first connect event fires (e.g., if the service was restarted mid-session).
   */
  async isActive(): Promise<boolean> {
    if (!this.module) return false;
    return this.module.isSessionActive();
  }

  /**
   * Remove all event subscriptions and clear listener set.
   * Call when the RN bridge is being torn down (e.g., app backgrounded long-term).
   */
  destroy(): void {
    this.connectSub?.remove();
    this.connectSub = null;
    this.disconnectSub?.remove();
    this.disconnectSub = null;
    this.listeners.clear();
    this.lastState = null;
    this.connected = false;
  }
}

export const androidAutoService = new AndroidAutoService();
