/**
 * WebSocketService — Socket.io client with exponential-backoff reconnection,
 * heartbeat ping/pong, AppState awareness, and location update throttling.
 * Requirements: 43.2
 */

import { AppState, AppStateStatus } from 'react-native';
import { io, Socket, ManagerOptions, SocketOptions } from 'socket.io-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SocketEventMap = Record<string, (...args: unknown[]) => void>;

export interface WebSocketConfig {
  url: string;
  auth: Record<string, string>;
  /** Start delay in ms (default 1000). */
  initialDelayMs?: number;
  /** Max delay cap in ms (default 30000). */
  maxDelayMs?: number;
  /** Heartbeat ping interval in ms (default 25000). */
  heartbeatIntervalMs?: number;
  /** Location update throttle in ms (default 1000 = 1/second). */
  locationThrottleMs?: number;
  /**
   * Called when the server rejects the connection with an auth error (e.g. expired token).
   * Should refresh the access token and return the new one, or throw if refresh fails.
   */
  onAuthError?: () => Promise<string>;
  /**
   * Called when the auth token refresh itself fails (e.g. refresh token expired).
   * Typically used to force the user back to the login screen.
   */
  onAuthFailed?: () => void;
}

// ---------------------------------------------------------------------------
// Helpers — exported for testing
// ---------------------------------------------------------------------------

/**
 * Compute next backoff delay with jitter (Req 43.2).
 * Starts at `initialMs`, doubles each attempt, caps at `maxMs`, adds ±25% jitter.
 */
export function computeBackoffMs(
  attempt: number,
  initialMs: number = 1_000,
  maxMs: number = 30_000,
): number {
  const base = Math.min(initialMs * Math.pow(2, attempt), maxMs);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/**
 * Consecutive token-refresh failures tolerated before the connection is
 * declared dead (onAuthFailed). A refresh usually fails because the device is
 * in a dead zone — not because the refresh token was revoked — so a single
 * failure must NOT bounce the driver to the login screen mid-convoy.
 */
export const MAX_AUTH_REFRESH_FAILURES = 3;

// ---------------------------------------------------------------------------
// WebSocketService
// ---------------------------------------------------------------------------

type ResolvedWebSocketConfig = Required<
  Pick<
    WebSocketConfig,
    'url' | 'auth' | 'initialDelayMs' | 'maxDelayMs' | 'heartbeatIntervalMs' | 'locationThrottleMs'
  >
> &
  Pick<WebSocketConfig, 'onAuthError' | 'onAuthFailed'>;

export class WebSocketService {
  private socket: Socket | null = null;
  private readonly config: ResolvedWebSocketConfig;

  // Heartbeat
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // AppState
  private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
  private appState: AppStateStatus = AppState.currentState;

  // Location throttle
  private lastLocationEmitTs = 0;
  private pendingLocationPayload: unknown = null;
  private locationThrottleTimer: ReturnType<typeof setTimeout> | null = null;

  // Auth refresh state — see _onConnectError
  private authRefreshInFlight = false;
  private authRefreshFailures = 0;
  private authRetryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: WebSocketConfig) {
    this.config = {
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
      heartbeatIntervalMs: 25_000,
      locationThrottleMs: 1_000,
      ...config,
    };
  }

  connect(): Socket {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }

    const opts: Partial<ManagerOptions & SocketOptions> = {
      transports: ['websocket'],
      auth: this.config.auth,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: this.config.initialDelayMs,
      reconnectionDelayMax: this.config.maxDelayMs,
      randomizationFactor: 0.25,
      timeout: 10_000,
    };

    this.socket = io(this.config.url, opts);

    this.socket.on('connect', () => {
      // A live connection proves auth is healthy — reset the dead-zone
      // refresh-failure streak so a later flap starts from a clean slate.
      this.authRefreshFailures = 0;
      this._startHeartbeat();
    });

    this.socket.on('disconnect', () => {
      this._stopHeartbeat();
    });

    this.socket.on('connect_error', (err: Error) => {
      void this._onConnectError(err);
    });

    this._subscribeAppState();

    return this.socket;
  }

  /**
   * connect_error handler — public only so tests can drive it directly.
   *
   * Auth errors trigger a token refresh and reconnect. A failed refresh is
   * usually a dead zone (refresh HTTP call had no network), NOT a revoked
   * refresh token — so instead of declaring auth dead on the first failure,
   * reconnection is resumed with backoff and only MAX_AUTH_REFRESH_FAILURES
   * consecutive failures escalate to onAuthFailed (which typically signs the
   * user out). A genuinely revoked token still escalates quickly: each
   * reconnect is rejected by the server with an auth error, the refresh fails
   * again, and the streak reaches the cap within a few backoff cycles.
   */
  async _onConnectError(err: Error): Promise<void> {
    const isAuthError =
      err.message.includes('401') ||
      err.message.toLowerCase().includes('unauthorized') ||
      err.message.toLowerCase().includes('token');

    if (!isAuthError || !this.config.onAuthError) return;

    // connect_error fires on every failed attempt — never stack refreshes.
    if (this.authRefreshInFlight) return;

    const s = this.socket;
    if (!s) return;

    this.authRefreshInFlight = true;

    // Pause socket.io's built-in reconnection so it can't race the refresh
    // with the stale token. NOTE: Manager#reconnection(boolean) is the live
    // switch — mutating `io.opts.reconnection` after construction is a no-op.
    s.io.reconnection(false);

    try {
      const newToken = await this.config.onAuthError();
      if (this.socket !== s) return; // socket replaced/disconnected mid-refresh
      s.auth = { ...(s.auth as Record<string, string>), token: newToken };
      this.authRefreshFailures = 0;
      s.io.reconnection(true);
      s.connect();
    } catch {
      if (this.socket !== s) return;
      this.authRefreshFailures += 1;
      if (this.authRefreshFailures >= MAX_AUTH_REFRESH_FAILURES) {
        this.config.onAuthFailed?.();
        return;
      }
      // Transient (likely offline) — resume reconnection and retry with the
      // standard jittered backoff instead of forcing a sign-out mid-drive.
      s.io.reconnection(true);
      if (this.authRetryTimer) clearTimeout(this.authRetryTimer);
      this.authRetryTimer = setTimeout(() => {
        this.authRetryTimer = null;
        if (this.socket === s && !s.connected) s.connect();
      }, computeBackoffMs(this.authRefreshFailures, this.config.initialDelayMs, this.config.maxDelayMs));
    } finally {
      this.authRefreshInFlight = false;
    }
  }

  /**
   * Emit a location update at most once per locationThrottleMs.
   * The most recent payload is buffered and flushed when the window expires.
   * When backgrounded, throttle increases to 5 s to save battery.
   */
  emitLocation(payload: unknown): void {
    if (!this.socket?.connected) return;

    const throttleMs =
      this.appState === 'background' || this.appState === 'inactive'
        ? 5_000
        : this.config.locationThrottleMs;

    const elapsed = Date.now() - this.lastLocationEmitTs;

    if (elapsed >= throttleMs) {
      this._flushLocation(payload);
    } else {
      this.pendingLocationPayload = payload;
      if (!this.locationThrottleTimer) {
        this.locationThrottleTimer = setTimeout(() => {
          this.locationThrottleTimer = null;
          if (this.pendingLocationPayload !== null) {
            this._flushLocation(this.pendingLocationPayload);
            this.pendingLocationPayload = null;
          }
        }, throttleMs - elapsed);
      }
    }
  }

  disconnect(): void {
    this._stopHeartbeat();
    this._unsubscribeAppState();
    if (this.authRetryTimer) {
      clearTimeout(this.authRetryTimer);
      this.authRetryTimer = null;
    }
    this.authRefreshFailures = 0;
    if (this.locationThrottleTimer) {
      clearTimeout(this.locationThrottleTimer);
      this.locationThrottleTimer = null;
    }
    this.pendingLocationPayload = null;
    this.socket?.disconnect();
    this.socket = null;
  }

  get instance(): Socket | null {
    return this.socket;
  }

  /**
   * Whether the underlying socket is currently connected. Consumers use this
   * to decide between live server push and degraded-mode fallbacks (e.g.
   * GroupChatScreen only polls a DM thread while the socket is down).
   */
  get connected(): boolean {
    return this.socket?.connected ?? false;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _flushLocation(payload: unknown): void {
    if (!this.socket?.connected) return;
    this.socket.emit('location:update', payload);
    this.lastLocationEmitTs = Date.now();
  }

  // The app-level 'ping' doubles as a presence heartbeat: the server refreshes
  // the Redis-backed `presence:online:<userId>` TTL on it (in addition to the
  // engine.io pong), so pausing it while backgrounded lets presence naturally
  // decay to offline for long-backgrounded apps.
  private _startHeartbeat(): void {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.connected) {
        this.socket.emit('ping');
      }
    }, this.config.heartbeatIntervalMs);
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private _subscribeAppState(): void {
    // connect() may be called repeatedly (e.g. after token refresh) — remove
    // any previous subscription first so AppState listeners don't accumulate.
    this._unsubscribeAppState();
    this.appStateSubscription = AppState.addEventListener('change', this._handleAppStateChange);
  }

  private _unsubscribeAppState(): void {
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
  }

  private _handleAppStateChange = (nextState: AppStateStatus): void => {
    const prev = this.appState;
    this.appState = nextState;

    if (nextState === 'active' && prev !== 'active') {
      // Foregrounded — reconnect if socket dropped while backgrounded.
      if (this.socket && !this.socket.connected) {
        this.socket.connect();
      }
      this._startHeartbeat();
    } else if ((nextState === 'background' || nextState === 'inactive') && prev === 'active') {
      // Backgrounded — pause heartbeat to save battery; socket.io reconnect
      // handles recovery when we return to foreground.
      this._stopHeartbeat();
    }
  };
}
