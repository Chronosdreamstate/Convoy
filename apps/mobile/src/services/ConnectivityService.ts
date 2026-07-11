/**
 * ConnectivityService — layered API-reachability monitor.
 *
 * Detection is event-driven: @react-native-community/netinfo's
 * `addEventListener` is the primary signal, so reachability changes fire
 * immediately instead of waiting for a poll tick. Because NetInfo only knows
 * about the device's link ("connected to WiFi"), not whether CONVOY's API is
 * actually reachable, a cheap unauthenticated GET /health probe is layered on
 * top as confirmation:
 *
 *  - NetInfo says offline  -> subscribers are notified offline immediately
 *    (no probe needed; if the radio is down the API is unreachable).
 *  - NetInfo says online   -> one /health probe runs first, and subscribers
 *    are only told "online" once the API answered.
 *
 * If the NetInfo module fails to load (native module missing in some
 * environment), the service degrades to a low-frequency /health poll — it
 * never runs NetInfo events and an interval poll at the same time.
 *
 * Implements SyncService's INetInfoProvider, so a mid-session connectivity
 * recovery (without backgrounding the app) triggers an offline sync.
 *
 * Requirements: 19.7 (offline resilience)
 */

import { AppState, AppStateStatus } from 'react-native';

/** Poll cadence used ONLY while NetInfo is unavailable (degraded mode). */
const FALLBACK_POLL_INTERVAL_MS = 150_000; // 2.5 min
const PROBE_TIMEOUT_MS = 5_000;

export type ReachabilityProbe = () => Promise<boolean>;
export type ConnectivityListener = (isOnline: boolean) => void;

/** Minimal slice of a NetInfo state object that this service reads. */
export interface NetInfoLikeState {
  isConnected: boolean | null;
  isInternetReachable?: boolean | null;
}

/** Minimal slice of the NetInfo module that this service uses. */
export interface NetInfoLikeModule {
  addEventListener(listener: (state: NetInfoLikeState) => void): (() => void) | void;
}

export type NetInfoLoader = () => NetInfoLikeModule | null;

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

/**
 * Default loader: resolve NetInfo lazily so a native-module load failure
 * degrades this service instead of crashing the import graph at startup.
 */
function defaultLoadNetInfo(): NetInfoLikeModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@react-native-community/netinfo');
    const netInfo = (mod?.default ?? mod) as NetInfoLikeModule | undefined;
    return netInfo && typeof netInfo.addEventListener === 'function' ? netInfo : null;
  } catch {
    return null;
  }
}

export class ConnectivityService {
  private subscribers = new Set<ConnectivityListener>();
  private lastState: boolean | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private netInfoUnsub: (() => void) | null = null;
  private appStateSub: { remove: () => void } | null = null;
  private started = false;
  private probing = false;
  private recheckRequested = false;
  /** Bumped on every NetInfo offline event to invalidate in-flight probes. */
  private offlineEpoch = 0;

  constructor(
    private readonly probe: ReachabilityProbe = defaultProbe,
    private readonly fallbackPollIntervalMs: number = FALLBACK_POLL_INTERVAL_MS,
    private readonly loadNetInfo: NetInfoLoader = defaultLoadNetInfo,
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

  /** Last known reachability, or null if nothing has been determined yet. */
  get isOnline(): boolean | null {
    return this.lastState;
  }

  /**
   * Run a reachability probe now. Notifies subscribers on state transitions;
   * when `forceNotifyIfOnline` is set, an online result is broadcast even
   * without a transition (used on app-foreground so sync always re-runs).
   *
   * If a probe is already in flight, a re-check is queued instead of running
   * two concurrent probes (so a NetInfo "online" arriving mid-probe still
   * gets a fresh confirmation).
   */
  async checkNow(forceNotifyIfOnline = false): Promise<void> {
    if (this.probing) {
      this.recheckRequested = true;
      return;
    }
    this.probing = true;
    try {
      do {
        this.recheckRequested = false;
        const epochAtStart = this.offlineEpoch;
        const online = await this.probe();
        // Discard a stale "online" if NetInfo reported offline mid-probe.
        if (online && epochAtStart !== this.offlineEpoch) continue;
        this.setState(online, forceNotifyIfOnline);
      } while (this.recheckRequested);
    } finally {
      this.probing = false;
    }
  }

  /** Record a state and notify subscribers per the subscribe() contract. */
  private setState(online: boolean, forceNotifyIfOnline = false): void {
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
  }

  private onNetInfoChange(state: NetInfoLikeState): void {
    const linkLooksUp = state.isConnected === true && state.isInternetReachable !== false;
    if (!linkLooksUp) {
      // Offline is trusted immediately — no point probing an API over a dead
      // link, and sync consumers must stop retrying right away.
      this.offlineEpoch += 1;
      this.setState(false);
    } else {
      // Online is only announced after the API confirms it is reachable.
      void this.checkNow();
    }
  }

  private ensureStarted(): void {
    if (!this.started) {
      this.started = true;
      const netInfo = this.loadNetInfo();
      if (netInfo) {
        // Primary path: event-driven. NetInfo also invokes the listener once
        // with the current state on registration.
        const unsub = netInfo.addEventListener((state) => this.onNetInfoChange(state));
        this.netInfoUnsub = typeof unsub === 'function' ? unsub : null;
      } else {
        // Degraded path: NetInfo unavailable — low-frequency probe polling.
        this.pollTimer = setInterval(() => {
          // Skip explicit background/inactive polls — the OS throttles JS
          // timers in background anyway, and probing while backgrounded
          // wastes battery/data. 'unknown' (iOS startup) still probes.
          const appState = AppState.currentState;
          if (appState !== 'background' && appState !== 'inactive') void this.checkNow();
        }, this.fallbackPollIntervalMs);
      }
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
    this.netInfoUnsub?.();
    this.netInfoUnsub = null;
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.started = false;
  }
}

export const connectivityService = new ConnectivityService();
