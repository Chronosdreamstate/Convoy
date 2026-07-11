/**
 * Unit tests for ConnectivityService — the event-driven reachability monitor
 * layered on @react-native-community/netinfo with /health confirmation.
 *
 * Covers:
 *  - NetInfo mode (primary):
 *    - subscribing kicks a confirmation probe and notifies on the first result
 *    - a late subscriber immediately receives the last known state
 *    - a NetInfo offline event notifies offline immediately, with no probe
 *    - a NetInfo online event is gated behind one successful /health probe
 *    - a NetInfo online event whose probe fails does NOT announce online
 *    - a probe that resolves "online" after NetInfo went offline is discarded
 *    - no interval polling happens while NetInfo is active
 *    - unsubscribing the last subscriber detaches the NetInfo listener
 *    - one throwing subscriber does not prevent others from being notified
 *    - app-foreground forces a probe and re-broadcasts online (sync re-run)
 *  - Fallback mode (NetInfo module unavailable):
 *    - degrades to low-frequency polling and still detects transitions
 *    - steady-state polls do not re-notify without a transition
 *    - polling stops after the last subscriber unsubscribes
 *  - Default loader resolves the (jest-mapped) NetInfo module
 */

import { AppState } from 'react-native';
import NetInfoMock from '@react-native-community/netinfo';

import {
  ConnectivityService,
  NetInfoLikeModule,
  NetInfoLikeState,
} from './ConnectivityService';

const FALLBACK_POLL_MS = 150_000;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/** Controllable NetInfo stand-in: capture listeners, emit states on demand. */
function makeFakeNetInfo() {
  const listeners = new Set<(state: NetInfoLikeState) => void>();
  const module: NetInfoLikeModule = {
    addEventListener(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    module,
    listeners,
    emit(state: NetInfoLikeState) {
      for (const l of listeners) l(state);
    },
    emitOnline() {
      this.emit({ isConnected: true, isInternetReachable: true });
    },
    emitOffline() {
      this.emit({ isConnected: false, isInternetReachable: false });
    },
  };
}

function makeProbe(results: boolean[] | (() => Promise<boolean>)) {
  return jest.fn(
    typeof results === 'function'
      ? results
      : () => Promise.resolve(results.length > 1 ? (results.shift() as boolean) : results[0]),
  );
}

function makeService(
  results: boolean[] | (() => Promise<boolean>),
  netInfo: NetInfoLikeModule | null,
) {
  const probe = makeProbe(results);
  const service = new ConnectivityService(probe, FALLBACK_POLL_MS, () => netInfo);
  return { service, probe };
}

// ---------------------------------------------------------------------------
// NetInfo mode (primary, event-driven)
// ---------------------------------------------------------------------------

describe('NetInfo mode', () => {
  it('probes immediately on subscribe and notifies with the first result', async () => {
    const net = makeFakeNetInfo();
    const { service, probe } = makeService([true], net.module);
    const listener = jest.fn();
    const unsub = service.subscribe(listener);

    await jest.advanceTimersByTimeAsync(0);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(true);
    unsub();
  });

  it('a late subscriber immediately receives the last known state', async () => {
    const net = makeFakeNetInfo();
    const { service } = makeService([false], net.module);
    const first = jest.fn();
    const unsub1 = service.subscribe(first);
    await jest.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledWith(false);

    const late = jest.fn();
    const unsub2 = service.subscribe(late);
    expect(late).toHaveBeenCalledWith(false); // synchronous, from cache
    unsub1();
    unsub2();
  });

  it('notifies offline immediately on a NetInfo offline event, without probing', async () => {
    const net = makeFakeNetInfo();
    const { service, probe } = makeService([true], net.module);
    const listener = jest.fn();
    const unsub = service.subscribe(listener);
    await jest.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenLastCalledWith(true);
    const probeCallsBefore = probe.mock.calls.length;

    net.emitOffline();

    // Offline is trusted synchronously — no probe over a dead link.
    expect(listener).toHaveBeenLastCalledWith(false);
    expect(service.isOnline).toBe(false);
    expect(probe).toHaveBeenCalledTimes(probeCallsBefore);
    unsub();
  });

  it('gates a NetInfo online event behind one successful /health probe', async () => {
    const net = makeFakeNetInfo();
    // First probe (on subscribe) fails: start offline. Next probe succeeds.
    const { service, probe } = makeService([false, true], net.module);
    const listener = jest.fn();
    const unsub = service.subscribe(listener);
    await jest.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenLastCalledWith(false);
    const probeCallsBefore = probe.mock.calls.length;

    net.emitOnline();
    // The event alone must not announce online — confirmation is async.
    expect(listener).toHaveBeenLastCalledWith(false);

    await jest.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(probeCallsBefore + 1);
    expect(listener).toHaveBeenLastCalledWith(true);
    expect(service.isOnline).toBe(true);
    unsub();
  });

  it('does not announce online when the confirmation probe fails', async () => {
    const net = makeFakeNetInfo();
    // Every probe fails: the API is down even though the link is up.
    const { service } = makeService([false], net.module);
    const listener = jest.fn();
    const unsub = service.subscribe(listener);
    await jest.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenLastCalledWith(false);
    const callsBefore = listener.mock.calls.length;

    net.emitOnline();
    await jest.advanceTimersByTimeAsync(0);

    expect(service.isOnline).toBe(false);
    // No new notification: still offline, no transition happened.
    expect(listener).toHaveBeenCalledTimes(callsBefore);
    unsub();
  });

  it('discards a stale "online" probe result when NetInfo went offline mid-probe', async () => {
    const net = makeFakeNetInfo();
    let resolveProbe: ((online: boolean) => void) | null = null;
    const probeFn = () =>
      new Promise<boolean>((resolve) => {
        resolveProbe = resolve;
      });
    const { service } = makeService(probeFn, net.module);
    const listener = jest.fn();
    const unsub = service.subscribe(listener); // probe now hanging

    net.emitOffline(); // radio drops while the probe is in flight
    expect(listener).toHaveBeenLastCalledWith(false);

    resolveProbe!(true); // stale success from before the drop
    await jest.advanceTimersByTimeAsync(0);

    expect(service.isOnline).toBe(false);
    expect(listener).toHaveBeenLastCalledWith(false);
    unsub();
  });

  it('does not interval-poll while NetInfo is active', async () => {
    const net = makeFakeNetInfo();
    const { service, probe } = makeService([true], net.module);
    const unsub = service.subscribe(jest.fn());
    await jest.advanceTimersByTimeAsync(0);
    const callsBefore = probe.mock.calls.length;

    await jest.advanceTimersByTimeAsync(FALLBACK_POLL_MS * 5);

    expect(probe).toHaveBeenCalledTimes(callsBefore); // no dual-polling
    unsub();
  });

  it('detaches the NetInfo listener after the last subscriber unsubscribes', async () => {
    const net = makeFakeNetInfo();
    const { service } = makeService([true], net.module);
    const unsub = service.subscribe(jest.fn());
    await jest.advanceTimersByTimeAsync(0);
    expect(net.listeners.size).toBe(1);

    unsub();
    expect(net.listeners.size).toBe(0);
  });

  it('a throwing subscriber does not prevent others from being notified', async () => {
    const net = makeFakeNetInfo();
    const { service } = makeService([true], net.module);
    const bad = jest.fn(() => {
      throw new Error('boom');
    });
    const good = jest.fn();
    const unsub1 = service.subscribe(bad);
    const unsub2 = service.subscribe(good);

    await jest.advanceTimersByTimeAsync(0);
    expect(good).toHaveBeenCalledWith(true);
    unsub1();
    unsub2();
  });

  it('foregrounding forces a probe and re-broadcasts online even without a transition', async () => {
    let appStateHandler: ((state: string) => void) | null = null;
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _type: string,
      handler: (state: string) => void,
    ) => {
      appStateHandler = handler;
      return { remove: jest.fn() };
    }) as unknown as typeof AppState.addEventListener);

    const net = makeFakeNetInfo();
    const { service, probe } = makeService([true], net.module);
    const listener = jest.fn();
    const unsub = service.subscribe(listener);
    await jest.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledTimes(1);
    const probeCallsBefore = probe.mock.calls.length;

    appStateHandler!('active');
    await jest.advanceTimersByTimeAsync(0);

    expect(probe).toHaveBeenCalledTimes(probeCallsBefore + 1);
    expect(listener).toHaveBeenCalledTimes(2); // re-broadcast despite no change
    expect(listener).toHaveBeenLastCalledWith(true);
    unsub();
  });
});

// ---------------------------------------------------------------------------
// Fallback mode (NetInfo module unavailable)
// ---------------------------------------------------------------------------

describe('fallback polling mode (NetInfo unavailable)', () => {
  it('notifies true when connectivity recovers mid-session (offline -> online)', async () => {
    // offline for the first two probes, then back online
    const { service } = makeService([false, false, true], null);
    const listener = jest.fn();
    const unsub = service.subscribe(listener);

    await jest.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenLastCalledWith(false);

    await jest.advanceTimersByTimeAsync(FALLBACK_POLL_MS); // probe 2: still offline
    expect(listener).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(FALLBACK_POLL_MS); // probe 3: recovered
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(true);
    expect(service.isOnline).toBe(true);
    unsub();
  });

  it('does not re-notify while the state is unchanged', async () => {
    const { service, probe } = makeService([true], null);
    const listener = jest.fn();
    const unsub = service.subscribe(listener);
    await jest.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(FALLBACK_POLL_MS * 3);
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(listener).toHaveBeenCalledTimes(1); // still just the initial notify
    unsub();
  });

  it('stops probing after the last subscriber unsubscribes', async () => {
    const { service, probe } = makeService([true], null);
    const unsub = service.subscribe(jest.fn());
    await jest.advanceTimersByTimeAsync(0);
    const callsBefore = probe.mock.calls.length;

    unsub();
    await jest.advanceTimersByTimeAsync(FALLBACK_POLL_MS * 5);
    expect(probe).toHaveBeenCalledTimes(callsBefore);
  });
});

// ---------------------------------------------------------------------------
// Default NetInfo loader
// ---------------------------------------------------------------------------

describe('default NetInfo loader', () => {
  it('registers with the real (jest-mocked) NetInfo module', async () => {
    const addEventListener = NetInfoMock.addEventListener as unknown as jest.Mock;
    addEventListener.mockClear();

    const probe = makeProbe([true]);
    const service = new ConnectivityService(probe); // default loader
    const unsub = service.subscribe(jest.fn());
    await jest.advanceTimersByTimeAsync(0);

    expect(addEventListener).toHaveBeenCalledTimes(1);
    unsub();
  });
});
