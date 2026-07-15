/**
 * Unit tests for WebSocketService's connect_error auth handling.
 * Requirements: 43.2 (reconnect with backoff), 19.7 (offline resilience)
 *
 * The user story under test: a driver's access token expires mid-convoy while
 * they are in a dead zone. The token refresh HTTP call fails because there is
 * no network — NOT because the refresh token was revoked. The old behaviour
 * called onAuthFailed (sign-out!) on the first failed refresh and left
 * socket.io reconnection disabled. The service must instead:
 *  - retry with backoff on transient refresh failures,
 *  - only escalate to onAuthFailed after MAX_AUTH_REFRESH_FAILURES in a row,
 *  - never run two token refreshes concurrently,
 *  - reset the failure streak once a refresh (or connection) succeeds.
 */

import { WebSocketService, MAX_AUTH_REFRESH_FAILURES } from './WebSocketService';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeSocket {
  connected: boolean;
  auth: Record<string, string>;
  io: { reconnection: jest.Mock };
  connect: jest.Mock;
  disconnect: jest.Mock;
}

function makeFakeSocket(): FakeSocket {
  return {
    connected: false,
    auth: { token: 'old-token' },
    io: { reconnection: jest.fn() },
    connect: jest.fn(),
    disconnect: jest.fn(),
  };
}

const liveServices: WebSocketService[] = [];

function makeService(config: {
  onAuthError?: () => Promise<string>;
  onAuthFailed?: () => void;
} = {}): { svc: WebSocketService; fake: FakeSocket } {
  const svc = new WebSocketService({
    url: 'ws://convoy.test',
    auth: { token: 'old-token' },
    ...config,
  });
  const fake = makeFakeSocket();
  // Inject the fake socket in place of a real socket.io connection.
  (svc as unknown as { socket: FakeSocket }).socket = fake;
  liveServices.push(svc);
  return { svc, fake };
}

const authError = new Error('401 unauthorized: token expired');

afterEach(() => {
  // Clear any scheduled backoff-retry timers so Jest can exit cleanly.
  for (const svc of liveServices.splice(0)) svc.disconnect();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Non-auth errors and missing config
// ---------------------------------------------------------------------------

describe('_onConnectError — non-auth errors', () => {
  it('ignores plain network connect errors (no refresh, no sign-out)', async () => {
    const onAuthError = jest.fn();
    const onAuthFailed = jest.fn();
    const { svc, fake } = makeService({ onAuthError, onAuthFailed });

    await svc._onConnectError(new Error('websocket error'));
    await svc._onConnectError(new Error('timeout'));

    expect(onAuthError).not.toHaveBeenCalled();
    expect(onAuthFailed).not.toHaveBeenCalled();
    expect(fake.io.reconnection).not.toHaveBeenCalled();
  });

  it('does nothing when no onAuthError handler is configured', async () => {
    const { svc, fake } = makeService();
    await svc._onConnectError(authError);
    expect(fake.io.reconnection).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Successful refresh
// ---------------------------------------------------------------------------

describe('_onConnectError — successful token refresh', () => {
  it('pauses reconnection, swaps the token, resumes reconnection, reconnects', async () => {
    const onAuthError = jest.fn().mockResolvedValue('new-token');
    const onAuthFailed = jest.fn();
    const { svc, fake } = makeService({ onAuthError, onAuthFailed });

    await svc._onConnectError(authError);

    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(fake.auth.token).toBe('new-token');
    // Reconnection paused for the refresh, then resumed.
    expect(fake.io.reconnection.mock.calls).toEqual([[false], [true]]);
    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(onAuthFailed).not.toHaveBeenCalled();
  });

  it('never stacks concurrent refreshes when connect_error fires repeatedly', async () => {
    let release!: (token: string) => void;
    const onAuthError = jest.fn(
      () => new Promise<string>((resolve) => { release = resolve; }),
    );
    const { svc } = makeService({ onAuthError });

    const first = svc._onConnectError(authError);
    const second = svc._onConnectError(authError); // fires while refresh in flight
    release('new-token');
    await Promise.all([first, second]);

    expect(onAuthError).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Transient refresh failure (dead zone)
// ---------------------------------------------------------------------------

describe('_onConnectError — transient refresh failure', () => {
  it('a single failed refresh does NOT sign the user out and resumes reconnection', async () => {
    const onAuthError = jest.fn().mockRejectedValue(new Error('Network Error'));
    const onAuthFailed = jest.fn();
    const { svc, fake } = makeService({ onAuthError, onAuthFailed });

    await svc._onConnectError(authError);

    expect(onAuthFailed).not.toHaveBeenCalled();
    // Reconnection must be re-enabled even though the refresh failed.
    expect(fake.io.reconnection.mock.calls).toEqual([[false], [true]]);
  });

  it('schedules a backoff retry that reconnects the same socket', async () => {
    jest.useFakeTimers();
    const onAuthError = jest.fn().mockRejectedValue(new Error('Network Error'));
    const { svc, fake } = makeService({ onAuthError });

    await svc._onConnectError(authError);
    expect(fake.connect).not.toHaveBeenCalled();

    // Max delay is 30 s + 25% jitter — 40 s covers every possible schedule.
    jest.advanceTimersByTime(40_000);
    expect(fake.connect).toHaveBeenCalledTimes(1);
  });

  it('escalates to onAuthFailed only after MAX_AUTH_REFRESH_FAILURES consecutive failures', async () => {
    const onAuthError = jest.fn().mockRejectedValue(new Error('Network Error'));
    const onAuthFailed = jest.fn();
    const { svc } = makeService({ onAuthError, onAuthFailed });

    for (let i = 0; i < MAX_AUTH_REFRESH_FAILURES - 1; i++) {
      await svc._onConnectError(authError);
      expect(onAuthFailed).not.toHaveBeenCalled();
    }

    await svc._onConnectError(authError);
    expect(onAuthFailed).toHaveBeenCalledTimes(1);
  });

  it('a successful refresh resets the failure streak', async () => {
    const onAuthError = jest.fn();
    const onAuthFailed = jest.fn();
    const { svc } = makeService({ onAuthError, onAuthFailed });

    // Two failures (one short of the cap) ...
    onAuthError.mockRejectedValue(new Error('Network Error'));
    await svc._onConnectError(authError);
    await svc._onConnectError(authError);

    // ... then a success ...
    onAuthError.mockResolvedValue('fresh-token');
    await svc._onConnectError(authError);
    expect(onAuthFailed).not.toHaveBeenCalled();

    // ... two more failures must still be below the cap (streak was reset).
    onAuthError.mockRejectedValue(new Error('Network Error'));
    await svc._onConnectError(authError);
    await svc._onConnectError(authError);
    expect(onAuthFailed).not.toHaveBeenCalled();
  });

  it('a socket replaced mid-refresh is never mutated or reconnected', async () => {
    let reject!: (err: Error) => void;
    const onAuthError = jest.fn(
      () => new Promise<string>((_res, rej) => { reject = rej; }),
    );
    const onAuthFailed = jest.fn();
    const { svc, fake } = makeService({ onAuthError, onAuthFailed });

    const pending = svc._onConnectError(authError);
    // Socket torn down while the refresh is in flight (e.g. screen unmount).
    (svc as unknown as { socket: FakeSocket | null }).socket = null;
    reject(new Error('Network Error'));
    await pending;

    expect(onAuthFailed).not.toHaveBeenCalled();
    expect(fake.connect).not.toHaveBeenCalled();
  });
});
