/**
 * Unit tests for ConnectivityService — the periodic /health reachability
 * monitor that stands in for @react-native-community/netinfo (not installed).
 *
 * Covers:
 *  - subscribing kicks an immediate probe and notifies on the first result
 *  - steady-state polls do not re-notify without a transition
 *  - an offline -> online transition mid-session notifies subscribers
 *    (the regression this service exists to fix: reconnect without
 *    backgrounding the app must trigger a sync)
 *  - a late subscriber immediately receives the last known state
 *  - unsubscribing the last subscriber stops the poll loop
 *  - one throwing subscriber does not prevent others from being notified
 */

import { ConnectivityService } from './ConnectivityService';

const POLL_MS = 30_000;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

function makeService(results: boolean[] | (() => Promise<boolean>)) {
  const probe = jest.fn(
    typeof results === 'function'
      ? results
      : () => Promise.resolve(results.length > 1 ? (results.shift() as boolean) : results[0]),
  );
  return { service: new ConnectivityService(probe, POLL_MS), probe };
}

describe('subscribe', () => {
  it('probes immediately and notifies with the first result', async () => {
    const { service, probe } = makeService([true]);
    const listener = jest.fn();
    const unsub = service.subscribe(listener);

    await jest.advanceTimersByTimeAsync(0);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(true);
    unsub();
  });

  it('a late subscriber immediately receives the last known state', async () => {
    const { service } = makeService([false]);
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
});

describe('polling and transitions', () => {
  it('does not re-notify while the state is unchanged', async () => {
    const { service, probe } = makeService([true]);
    const listener = jest.fn();
    const unsub = service.subscribe(listener);
    await jest.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(listener).toHaveBeenCalledTimes(1); // still just the initial notify
    unsub();
  });

  it('notifies true when connectivity recovers mid-session (offline -> online)', async () => {
    // offline for the first two probes, then back online
    const { service } = makeService([false, false, true]);
    const listener = jest.fn();
    const unsub = service.subscribe(listener);

    await jest.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenLastCalledWith(false);

    await jest.advanceTimersByTimeAsync(POLL_MS); // probe 2: still offline
    expect(listener).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(POLL_MS); // probe 3: recovered
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(true);
    expect(service.isOnline).toBe(true);
    unsub();
  });

  it('stops probing after the last subscriber unsubscribes', async () => {
    const { service, probe } = makeService([true]);
    const unsub = service.subscribe(jest.fn());
    await jest.advanceTimersByTimeAsync(0);
    const callsBefore = probe.mock.calls.length;

    unsub();
    await jest.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(probe).toHaveBeenCalledTimes(callsBefore);
  });

  it('a throwing subscriber does not prevent others from being notified', async () => {
    const { service } = makeService([true]);
    const bad = jest.fn(() => { throw new Error('boom'); });
    const good = jest.fn();
    const unsub1 = service.subscribe(bad);
    const unsub2 = service.subscribe(good);

    await jest.advanceTimersByTimeAsync(0);
    expect(good).toHaveBeenCalledWith(true);
    unsub1();
    unsub2();
  });
});
