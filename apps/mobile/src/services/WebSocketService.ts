/**
 * WebSocketService — Socket.io client with exponential-backoff reconnection.
 * Requirements: 43.2
 */

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
  /**
   * Called when the server rejects the connection with an auth error (e.g. expired token).
   * Should refresh the access token and return the new one, or throw if refresh fails.
   * When provided, the service will update socket.auth and retry the connection automatically.
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

/** Resolved config with numeric defaults filled in; optional callbacks stay optional. */
type ResolvedWebSocketConfig = Required<Pick<WebSocketConfig, 'url' | 'auth' | 'initialDelayMs' | 'maxDelayMs'>> &
  Pick<WebSocketConfig, 'onAuthError' | 'onAuthFailed'>;

export class WebSocketService {
  private socket: Socket | null = null;
  private readonly config: ResolvedWebSocketConfig;

  constructor(config: WebSocketConfig) {
    this.config = {
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
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
    };

    this.socket = io(this.config.url, opts);

    // Handle auth errors (e.g. expired access token) on connect/reconnect attempts.
    // socket.io fires connect_error when the server middleware calls next(new Error(...)).
    this.socket.on('connect_error', async (err: Error) => {
      const isAuthError =
        err.message.includes('401') ||
        err.message.toLowerCase().includes('unauthorized') ||
        err.message.toLowerCase().includes('token');

      if (!isAuthError || !this.config.onAuthError) return;

      // Capture reference so the async continuation always holds the same socket instance.
      const s = this.socket;
      if (!s) return;

      // Prevent socket.io's built-in reconnection from racing with our refresh.
      s.io.opts.reconnection = false;

      try {
        const newToken = await this.config.onAuthError();
        s.auth = { ...s.auth, token: newToken };
        // Re-enable reconnection and initiate the retry.
        s.io.opts.reconnection = true;
        s.connect();
      } catch {
        // Refresh failed — session is unrecoverable; notify the caller.
        this.config.onAuthFailed?.();
      }
    });

    return this.socket;
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  get instance(): Socket | null {
    return this.socket;
  }
}
