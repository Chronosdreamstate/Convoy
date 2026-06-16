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

export class WebSocketService {
  private socket: Socket | null = null;
  private readonly config: Required<WebSocketConfig>;

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
