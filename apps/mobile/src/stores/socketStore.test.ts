/**
 * Unit tests for socketStore — specifically the live `isConnected` wiring.
 *
 * The store attaches per-socket connect/disconnect listeners in setSocket, so
 * `isConnected` tracks the ACTIVE socket only:
 *  - snapshot of socket.connected on setSocket
 *  - flips true/false on the socket's connect/disconnect events
 *  - a replaced (stale) socket can never flip the flag for its successor
 *  - detaching uses handler references, so other listeners on the same events
 *    (heartbeat, screen handlers) are untouched
 */

import type { Socket } from 'socket.io-client';
import { useSocketStore } from './socketStore';

type Handler = (...args: unknown[]) => void;

interface FakeSocket {
  connected: boolean;
  on: jest.Mock;
  off: jest.Mock;
  disconnect: jest.Mock;
  emit: jest.Mock;
  fire(event: string, ...args: unknown[]): void;
  listenerCount(event: string): number;
}

function makeFakeSocket(connected = false): FakeSocket {
  const handlers = new Map<string, Set<Handler>>();
  const get = (ev: string) => {
    if (!handlers.has(ev)) handlers.set(ev, new Set());
    return handlers.get(ev)!;
  };
  const socket: FakeSocket = {
    connected,
    on: jest.fn((ev: string, h: Handler) => { get(ev).add(h); return socket; }),
    off: jest.fn((ev: string, h?: Handler) => {
      if (h) get(ev).delete(h);
      else handlers.delete(ev);
      return socket;
    }),
    disconnect: jest.fn(() => { socket.connected = false; return socket; }),
    emit: jest.fn(),
    fire(ev: string, ...args: unknown[]) {
      [...get(ev)].forEach((h) => h(...args));
    },
    listenerCount(ev: string) {
      return handlers.get(ev)?.size ?? 0;
    },
  };
  return socket;
}

const asSocket = (s: FakeSocket) => s as unknown as Socket;

afterEach(() => {
  useSocketStore.getState().reset();
});

describe('socketStore.isConnected', () => {
  it('snapshots socket.connected when the socket is set', () => {
    const s = makeFakeSocket(true);
    useSocketStore.getState().setSocket(asSocket(s));
    expect(useSocketStore.getState().isConnected).toBe(true);

    useSocketStore.getState().setSocket(null);
    expect(useSocketStore.getState().isConnected).toBe(false);
  });

  it('flips on the active socket connect/disconnect events', () => {
    const s = makeFakeSocket(false);
    useSocketStore.getState().setSocket(asSocket(s));
    expect(useSocketStore.getState().isConnected).toBe(false);

    s.connected = true;
    s.fire('connect');
    expect(useSocketStore.getState().isConnected).toBe(true);

    s.connected = false;
    s.fire('disconnect');
    expect(useSocketStore.getState().isConnected).toBe(false);

    // Reconnect after a drop (socket.io reuses the same socket instance)
    s.connected = true;
    s.fire('connect');
    expect(useSocketStore.getState().isConnected).toBe(true);
  });

  it('a replaced socket can no longer drive isConnected (multi-instance handoff)', () => {
    // Same handoff as ConvoyLobbyScreen -> MapScreen: a second
    // WebSocketService replaces the lobby's socket in the store.
    const lobby = makeFakeSocket(true);
    const convoy = makeFakeSocket(false);

    useSocketStore.getState().setSocket(asSocket(lobby));
    expect(useSocketStore.getState().isConnected).toBe(true);

    useSocketStore.getState().setSocket(asSocket(convoy));
    expect(useSocketStore.getState().isConnected).toBe(false);
    // The store disconnects the replaced socket
    expect(lobby.disconnect).toHaveBeenCalled();

    // Stale socket events must not leak into the new socket's flag
    lobby.fire('connect');
    expect(useSocketStore.getState().isConnected).toBe(false);
    lobby.fire('disconnect');

    convoy.connected = true;
    convoy.fire('connect');
    expect(useSocketStore.getState().isConnected).toBe(true);
  });

  it('detaches its own connect/disconnect handlers by reference, leaving others attached', () => {
    const s = makeFakeSocket(false);
    // A screen-level listener on the same events (e.g. MapScreen banner logic)
    const screenHandler = jest.fn();
    s.on('connect', screenHandler);

    useSocketStore.getState().setSocket(asSocket(s));
    expect(s.listenerCount('connect')).toBe(2);

    useSocketStore.getState().setSocket(null);
    // Only the store's handler was removed
    expect(s.listenerCount('connect')).toBe(1);
    s.fire('connect');
    expect(screenHandler).toHaveBeenCalledTimes(1);
  });

  it('re-setting the same socket does not stack duplicate listeners', () => {
    const s = makeFakeSocket(false);
    useSocketStore.getState().setSocket(asSocket(s));
    const countAfterFirst = s.listenerCount('connect');

    useSocketStore.getState().setSocket(asSocket(s));
    expect(s.listenerCount('connect')).toBe(countAfterFirst);
    // And the same-socket call must not disconnect it
    expect(s.disconnect).not.toHaveBeenCalled();

    // Refreshes the snapshot though
    s.connected = true;
    useSocketStore.getState().setSocket(asSocket(s));
    expect(useSocketStore.getState().isConnected).toBe(true);
  });

  it('reset() clears the socket, connectivity, and presence state', () => {
    const s = makeFakeSocket(true);
    useSocketStore.getState().setSocket(asSocket(s));
    s.fire('member:online', { userId: 'u1' });
    expect(useSocketStore.getState().onlineUserIds.has('u1')).toBe(true);

    useSocketStore.getState().reset();

    expect(useSocketStore.getState().socket).toBeNull();
    expect(useSocketStore.getState().isConnected).toBe(false);
    expect(useSocketStore.getState().onlineUserIds.size).toBe(0);
    expect(useSocketStore.getState().lastSeenMap.size).toBe(0);
    expect(s.disconnect).toHaveBeenCalled();
  });
});
