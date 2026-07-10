/**
 * ConnectivityService — lightweight API-reachability monitor.
 *
 * @react-native-community/netinfo is NOT installed in this project, so this
 * service approximates a connectivity listener: it probes the API's
 * unauthenticated /health endpoint on a fixed interval (plus immediately when
 * the app foregrounds and when the first subscriber attaches) and notifies
 * subscribers whenever reachability changes.
 *
 * Implements SyncService's INetInfoProvider, so a mid-session connectivity
 * recovery (without backgrounding the app) now triggers an offline sync —
 * previously sync only re-evaluated on AppState changes.
 *
 * Requirements: 19.7 (offline resilience)
 */

import { AppState, AppStateStatus } from 'react-native';

const POLL_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

export type ReachabilityProbe = () => Promise<boolean>;
export type ConnectivityListener = (isOnline: boolean) => void;

/**
 * Default probe: GET {API_URL}/health with a short timeout, using plain fetch
 * (NOT apiClient) so no auth token, 401-refresh, or retry/backoff interceptor
 * gets involved — a reachability check must be cheap and side-effect free.
 */
async function defaultProbe(): Promise<boolean> {
  const baseUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/health`, { method: 'GET', signal: controller.signal });
    return res.ok;
  } catch {
    return false; // network error, DNS failure, or timeout — treat as offline
  } finally {
    clearTimeout(timeout);
  }
}

export class ConnectivityService {
  private subscribers = new Set<ConnectivityListener>();
  private lastState: boolean | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private appStateSub: { remove: () => void } | null = null;
  private probing = false;

  constructor(
    private readonly probe: ReachabilityProbe = defaultProbe,
    private readonly pollIntervalMs: number = POLL_INTERVAL_MS,
  ) {}

  /**
   * Subscribe to reachability changes (INetInfoProvider contract).
   * The callback fires immediately with the last known state (if any), on
   * every online/offline transition, and with `true` after each foreground
   * probe that finds the API reachable (so foregrounding always re-syncs,
   * matching the previous AppState-based behaviour).
   * Returns an unsubscribe function.
   */
  subscribe(callback: ConnectivityListener): () => void {
    this.subscribers.add(callback);
    if (this.lastState !== null) callback(this.lastState);
    this.ensureStarted();
    void this.checkNow();
    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  /** Last probe result, or null if no probe has completed yet. */
  get isOnline(): boolean | null {
    return this.lastState;
  }

  /**
   * Run a reachability probe now. Notifies subscribers on state transitions;
   * when `forceNotifyIfOnline` is set, an online result is broadcast even
   * without a transition (used on app-foreground so sync always re-runs).
   */
  async checkNow(forceNotifyIfOnline = false): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      const online = await this.probe();
      const changed = online !== this.lastState;
      this.lastState = online;
      if (changed || (forceNotifyIfOnline && online)) {
        for (const cb of this.subscribers) {
          try {
            cb(online);
          } catch {
            // One misbehaving subscriber must not break the others.
          }
        }
      }
    } finally {
      this.probing = false;
    }
  }

  private ensureStarted(): void {
    if (this.pollTimer === null) {
      this.pollTimer = setInterval(() => {
        // Skip explicit background/inactive polls — the OS throttles JS timers
        // in background anyway, and probing while backgrounded wastes
        // battery/data. 'unknown' (iOS startup) still probes.
        const appState = AppState.currentState;
        if (appState !== 'background' && appState !== 'inactive') void this.checkNow();
      }, this.pollIntervalMs);
    }
    if (this.appStateSub === null) {
      this.appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
        if (state === 'active') void this.checkNow(true);
      });
    }
  }

  private stop(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.appStateSub?.remove();
    this.appStateSub = null;
  }
}

export const connectivityService = new ConnectivityService();
