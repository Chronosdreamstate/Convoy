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

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

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
}

// ---------------------------------------------------------------------------
// CarPlayService
// ---------------------------------------------------------------------------

type CarPlayListener = (connected: boolean) => void;

export class CarPlayService {
  private module: IConvoyCarPlayModule | null = null;
  private emitter: NativeEventEmitter | null = null;
  private listeners: Set<CarPlayListener> = new Set();

  constructor() {
    if (Platform.OS === 'ios' && NativeModules.ConvoyCarPlay) {
      this.module = NativeModules.ConvoyCarPlay as IConvoyCarPlayModule;
      this.emitter = new NativeEventEmitter(NativeModules.ConvoyCarPlay);
    }
  }

  /** Wire lifecycle events — returns an unsubscribe fn (Req 13.7, 28.1). */
  start(): () => void {
    if (!this.emitter) return () => {};

    const connectSub = this.emitter.addListener('CarPlayDidConnect', () => {
      this.listeners.forEach((l) => l(true));
    });
    const disconnectSub = this.emitter.addListener('CarPlayDidDisconnect', () => {
      this.listeners.forEach((l) => l(false));
    });

    return () => {
      connectSub.remove();
      disconnectSub.remove();
    };
  }

  /** Push current app state to the CarPlay native UI (Req 13.1–13.5). */
  syncState(state: CarPlayState): void {
    this.module?.syncState(state);
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
}

export const carPlayService = new CarPlayService();
