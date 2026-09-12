/**
 * The client half of socket token expiry.
 *
 * The server now holds a socket only as long as the token that opened it
 * (api plugins/socketio.ts): before that, a connection opened with a
 * 15-minute access token kept full access for days, and a sign-out or an
 * account deletion never reached it.
 *
 * Enforcing that on the server alone would have been a regression, for two
 * reasons this file pins:
 *
 *  1. socket.io does NOT auto-reconnect when the server closed the socket, and
 *     the `disconnect` handler only stopped the heartbeat — so every
 *     server-side close left the app silently offline until it happened to be
 *     backgrounded and foregrounded. That is already reachable today via a
 *     kick or an account deleted on another device, not just via expiry.
 *  2. A kicked member is force-disconnected while `auth.groupId` still names
 *     the group they were removed from, and the handshake rejects a group you
 *     are not a member of — so a plain refresh-and-retry spins forever, since
 *     the refresh itself keeps succeeding.
 */

// Capture what connect() registers, so the wiring itself is under test and not
// just the handlers it dispatches to.
const registered: Record<string, (...args: never[]) => void> = {};
const mockSocket = {
  connected: false,
  auth: { token: 'old-token' } as Record<string, string>,
  io: { reconnection: jest.fn() },
  connect: jest.fn(),
  disconnect: jest.fn(),
  emit: jest.fn(),
  on: jest.fn((event: string, listener: (...args: never[]) => void) => {
    registered[event] = listener;
  }),
};
jest.mock('socket.io-client', () => ({ io: () => mockSocket }));

jest.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: jest.fn() }) },
}));

import { WebSocketService, MAX_AUTH_REFRESH_FAILURES } from './WebSocketService';

interface FakeSocket {
  connected: boolean;
  auth: Record<string, string>;
  io: { reconnection: jest.Mock };
  connect: jest.Mock;
  disconnect: jest.Mock;
  emit: jest.Mock;
}

function makeFakeSocket(auth: Record<string, string>): FakeSocket {
  return {
    connected: false,
    auth,
    io: { reconnection: jest.fn() },
    connect: jest.fn(),
    disconnect: jest.fn(),
    emit: jest.fn(),
  };
}

const liveServices: WebSocketService[] = [];

function makeService(
  config: { onAuthError?: () => Promise<string>; onAuthFailed?: () => void } = {},
  auth: Record<string, string> = { token: 'old-token' },
): { svc: WebSocketService; fake: FakeSocket } {
  const svc = new WebSocketService({ url: 'ws://convoy.test', auth, ...config });
  const fake = makeFakeSocket({ ...auth });
  (svc as unknown as { socket: FakeSocket }).socket = fake;
  liveServices.push(svc);
  return { svc, fake };
}

afterEach(() => {
  for (const svc of liveServices.splice(0)) svc.disconnect();
  jest.useRealTimers();
});

describe('_refreshAuthInPlace — the healthy path, no drop', () => {
  it('sends the new token over the open socket instead of reconnecting', async () => {
    const onAuthError = jest.fn().mockResolvedValue('fresh-token');
    const { svc, fake } = makeService({ onAuthError });

    await svc._refreshAuthInPlace();

    expect(fake.emit).toHaveBeenCalledWith('auth:refresh', { token: 'fresh-token' });
    // The whole point: a driver mid-convoy keeps their connection.
    expect(fake.connect).not.toHaveBeenCalled();
    expect(fake.disconnect).not.toHaveBeenCalled();
  });

  it('also stores the new token, so a later reconnect does not present the dead one', async () => {
    const onAuthError = jest.fn().mockResolvedValue('fresh-token');
    const { svc, fake } = makeService({ onAuthError });

    await svc._refreshAuthInPlace();

    expect(fake.auth.token).toBe('fresh-token');
  });

  it('never runs two refreshes at once', async () => {
    let release: (t: string) => void = () => {};
    const onAuthError = jest.fn(
      () => new Promise<string>((resolve) => { release = resolve; }),
    );
    const { svc } = makeService({ onAuthError });

    const first = svc._refreshAuthInPlace();
    await svc._refreshAuthInPlace(); // must be a no-op while the first is open
    release('fresh-token');
    await first;

    expect(onAuthError).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the refresh fails — the server close is the fallback', async () => {
    const onAuthError = jest.fn().mockRejectedValue(new Error('offline'));
    const onAuthFailed = jest.fn();
    const { svc, fake } = makeService({ onAuthError, onAuthFailed });

    await svc._refreshAuthInPlace();

    // A dead zone must not sign a driver out mid-convoy.
    expect(onAuthFailed).not.toHaveBeenCalled();
    expect(fake.emit).not.toHaveBeenCalled();
  });
});

describe('_onServerDisconnect — recovering from a close the server initiated', () => {
  it('refreshes first, then reconnects', async () => {
    const onAuthError = jest.fn().mockResolvedValue('fresh-token');
    const { svc, fake } = makeService({ onAuthError });

    await svc._onServerDisconnect();

    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(fake.auth.token).toBe('fresh-token');
    expect(fake.connect).toHaveBeenCalledTimes(1);
  });

  it('drops the stale groupId so a kicked member cannot loop forever', async () => {
    // The kick path force-disconnects the socket while auth.groupId still
    // names the group. Reconnecting with it is rejected every time, and the
    // refresh keeps succeeding, so without this the client spins.
    const onAuthError = jest.fn().mockResolvedValue('fresh-token');
    const { svc, fake } = makeService(
      { onAuthError },
      { token: 'old-token', groupId: 'the-group-i-was-kicked-from' },
    );

    await svc._onServerDisconnect();

    expect(fake.auth.groupId).toBeUndefined();
    expect(fake.auth.token).toBe('fresh-token');
    expect(fake.connect).toHaveBeenCalledTimes(1);
  });

  it('still reconnects when the refresh fails — the old token may be fine', async () => {
    // A kick is not an expiry: the token is still good, so a dead-zone refresh
    // failure must not stop the client coming back.
    const onAuthError = jest.fn().mockRejectedValue(new Error('offline'));
    const onAuthFailed = jest.fn();
    const { svc, fake } = makeService({ onAuthError, onAuthFailed });

    await svc._onServerDisconnect();

    expect(onAuthFailed).not.toHaveBeenCalled();
    expect(fake.connect).toHaveBeenCalledTimes(1);
  });

  it('gives up only after the usual run of consecutive refresh failures', async () => {
    const onAuthError = jest.fn().mockRejectedValue(new Error('offline'));
    const onAuthFailed = jest.fn();
    const { svc, fake } = makeService({ onAuthError, onAuthFailed });

    for (let i = 0; i < MAX_AUTH_REFRESH_FAILURES; i++) {
      await svc._onServerDisconnect();
    }

    expect(onAuthFailed).toHaveBeenCalledTimes(1);
    // The last attempt escalated instead of reconnecting again.
    expect(fake.connect).toHaveBeenCalledTimes(MAX_AUTH_REFRESH_FAILURES - 1);
  });

  it('does not reconnect a socket that is already connected again', async () => {
    const onAuthError = jest.fn().mockResolvedValue('fresh-token');
    const { svc, fake } = makeService({ onAuthError });
    fake.connected = true;

    await svc._onServerDisconnect();

    expect(fake.connect).not.toHaveBeenCalled();
  });
});

describe('connect() wiring', () => {
  beforeEach(() => {
    for (const key of Object.keys(registered)) delete registered[key];
    mockSocket.emit.mockClear();
    mockSocket.connect.mockClear();
    mockSocket.auth = { token: 'old-token' };
    mockSocket.connected = false;
  });

  it('recovers when the SERVER closed the socket', async () => {
    const onAuthError = jest.fn().mockResolvedValue('fresh-token');
    const svc = new WebSocketService({
      url: 'ws://convoy.test',
      auth: { token: 'old-token' },
      onAuthError,
    });
    liveServices.push(svc);
    svc.connect();

    registered['disconnect']('io server disconnect' as never);
    await new Promise((r) => setImmediate(r));

    // Before this, the disconnect handler only stopped the heartbeat, and
    // socket.io does not reconnect itself after a server-initiated close — so
    // the app sat silently offline.
    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(mockSocket.connect).toHaveBeenCalledTimes(1);
  });

  it('leaves an ordinary network drop to the built-in reconnection', async () => {
    const onAuthError = jest.fn().mockResolvedValue('fresh-token');
    const svc = new WebSocketService({
      url: 'ws://convoy.test',
      auth: { token: 'old-token' },
      onAuthError,
    });
    liveServices.push(svc);
    svc.connect();

    registered['disconnect']('transport close' as never);
    await new Promise((r) => setImmediate(r));

    expect(onAuthError).not.toHaveBeenCalled();
    expect(mockSocket.connect).not.toHaveBeenCalled();
  });

  it('refreshes in place on the auth:expiring warning', async () => {
    const onAuthError = jest.fn().mockResolvedValue('fresh-token');
    const svc = new WebSocketService({
      url: 'ws://convoy.test',
      auth: { token: 'old-token' },
      onAuthError,
    });
    liveServices.push(svc);
    svc.connect();

    registered['auth:expiring']();
    await new Promise((r) => setImmediate(r));

    expect(mockSocket.emit).toHaveBeenCalledWith('auth:refresh', { token: 'fresh-token' });
    expect(mockSocket.connect).not.toHaveBeenCalled();
  });
});
