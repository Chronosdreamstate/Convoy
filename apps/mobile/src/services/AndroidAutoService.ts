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

import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';

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
}

// ---------------------------------------------------------------------------
// AndroidAutoService
// ---------------------------------------------------------------------------

type AutoListener = (connected: boolean) => void;

export class AndroidAutoService {
  private module: IConvoyAndroidAutoModule | null = null;
  private listeners: Set<AutoListener> = new Set();

  constructor() {
    if (Platform.OS === 'android' && NativeModules.ConvoyAndroidAuto) {
      this.module = NativeModules.ConvoyAndroidAuto as IConvoyAndroidAutoModule;
    }
  }

  /** Wire lifecycle events — returns unsubscribe fn (Req 13.7, 28.1). */
  start(): () => void {
    if (Platform.OS !== 'android') return () => {};

    const connectSub = DeviceEventEmitter.addListener('AndroidAutoDidConnect', () => {
      this.listeners.forEach((l) => l(true));
    });
    const disconnectSub = DeviceEventEmitter.addListener('AndroidAutoDidDisconnect', () => {
      this.listeners.forEach((l) => l(false));
    });

    return () => {
      connectSub.remove();
      disconnectSub.remove();
    };
  }

  /** Push current app state to Android Auto screens (Req 13.6). */
  syncState(state: AndroidAutoState): void {
    this.module?.syncState(state);
  }

  /** Subscribe to session changes — used by DrivingModeService. */
  onCarPlaySessionChange(cb: AutoListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async isActive(): Promise<boolean> {
    if (!this.module) return false;
    return this.module.isSessionActive();
  }
}

export const androidAutoService = new AndroidAutoService();
