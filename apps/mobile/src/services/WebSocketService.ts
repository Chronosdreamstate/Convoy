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
      this._startHeartbeat();
    });

    this.socket.on('disconnect', () => {
      this._stopHeartbeat();
    });

    this.socket.on('connect_error', async (err: Error) => {
      const isAuthError =
        err.message.includes('401') ||
        err.message.toLowerCase().includes('unauthorized') ||
        err.message.toLowerCase().includes('token');

      if (!isAuthError || !this.config.onAuthError) return;

      const s = this.socket;
      if (!s) return;

      // Prevent socket.io's built-in reconnection from racing with our token refresh.
      s.io.opts.reconnection = false;

      try {
        const newToken = await this.config.onAuthError();
        s.auth = { ...s.auth, token: newToken };
        s.io.opts.reconnection = true;
        s.connect();
      } catch {
        this.config.onAuthFailed?.();
      }
    });

    this._subscribeAppState();

    return this.socket;
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

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _flushLocation(payload: unknown): void {
    if (!this.socket?.connected) return;
    this.socket.emit('location:update', payload);
    this.lastLocationEmitTs = Date.now();
  }

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
