/**
 * Lifecycle tests for IdleMapScreen — the surface a signed-in rider sits on
 * whenever they have no active convoy, which makes it the screen most likely to
 * be left open, backgrounded, and come back to hours later.
 *
 * Everything here is about what the screen leaves running: a friends-location
 * poll that must not keep dialling out from behind a backgrounded app, and two
 * multi-second toast animations started from effects (one of them from inside a
 * 30s timer) that must not outlive the tree they animate.
 */

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Animated, AppState } from 'react-native';

// ---------------------------------------------------------------------------
// Native / platform stubs. These register native view managers or reach for
// device APIs at import time, neither of which exists under jest.
// ---------------------------------------------------------------------------

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children?: React.ReactNode }) => children ?? null,
  SafeAreaView: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

jest.mock('react-native-maps', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const stub = (name: string) => (props: { children?: unknown }) =>
    R.createElement(name, props as never, props.children as never);
  return {
    __esModule: true,
    default: stub('MapView'),
    Marker: stub('Marker'),
    Callout: stub('Callout'),
    PROVIDER_DEFAULT: 'default',
  };
});

// Permission denied keeps the GPS watch out of the picture — these tests are
// about the poll and the toasts, both of which run regardless of location.
jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  requestForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  getCurrentPositionAsync: jest.fn().mockResolvedValue({ coords: { latitude: 51.5, longitude: -0.12 } }),
  watchPositionAsync: jest.fn().mockResolvedValue({ remove: jest.fn() }),
  Accuracy: { Balanced: 3, High: 4, BestForNavigation: 6 },
}));

const mockApiGet = jest.fn();
jest.mock('../../services/apiClient', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: jest.fn().mockResolvedValue({ data: {} }),
  },
}));

// SQLite is a native module; the offline hazard queue opens a database on import.
jest.mock('../../services/OfflineCacheService', () => ({
  SQLiteOfflineDB: class {
    init = jest.fn().mockResolvedValue(undefined);
    getPendingHazards = jest.fn().mockResolvedValue([]);
    clearHazards = jest.fn().mockResolvedValue(undefined);
    saveHazard = jest.fn().mockResolvedValue(undefined);
  },
}));

jest.mock('../../services/WebSocketService', () => ({
  WebSocketService: class {
    connect() {
      return { on: jest.fn(), off: jest.fn(), emit: jest.fn() };
    }
    disconnect() {}
    emitLocation() {}
  },
}));

import * as ExpoLocation from 'expo-location';
import { useAuthStore } from '../../stores/authStore';
import IdleMapScreen from './IdleMapScreen';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = '11111111-1111-1111-1111-111111111111';

/** Captures the screen's AppState subscriber so a test can drive foreground/background. */
function captureAppState(): { fire: (state: string) => void } {
  let cb: ((state: string) => void) | undefined;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
    cb = handler as (state: string) => void;
    return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
  });
  return { fire: (state) => cb?.(state) };
}

function friendLocationCalls(): number {
  return mockApiGet.mock.calls.filter((c) => String(c[0]).includes('/friends/locations')).length;
}

async function mountScreen(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<IdleMapScreen />);
  });
  // Mount effects fire a handful of requests; let them settle.
  await act(async () => {});
  return renderer;
}

beforeEach(() => {
  jest.useFakeTimers();
  mockApiGet.mockReset();
  mockApiGet.mockResolvedValue({ data: { locations: [], friends: [], groups: [], hazards: [] } });
  useAuthStore.setState({
    user: { id: USER_ID, displayName: 'Test Driver' } as never,
    token: 'test-token',
    isAuthenticated: true,
  } as never);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Friends-location poll
// ---------------------------------------------------------------------------

describe('IdleMapScreen — friends-location poll', () => {
  it('polls every 20s while the screen is in front of the user', async () => {
    captureAppState();
    await mountScreen();
    expect(friendLocationCalls()).toBe(1);

    await act(async () => { jest.advanceTimersByTime(20_000); });
    expect(friendLocationCalls()).toBe(2);
  });

  it('stops polling while the app is backgrounded and refreshes on return', async () => {
    const appState = captureAppState();
    await mountScreen();
    expect(friendLocationCalls()).toBe(1);

    // Backgrounded: three requests a minute for an overlay nobody can see.
    await act(async () => { appState.fire('background'); });
    await act(async () => { jest.advanceTimersByTime(120_000); });
    expect(friendLocationCalls()).toBe(1);

    // Coming back, the pins on screen are two minutes old — refresh at once
    // rather than waiting out another interval.
    await act(async () => { appState.fire('active'); });
    expect(friendLocationCalls()).toBe(2);
  });

  it('stops polling once the screen is gone', async () => {
    captureAppState();
    const renderer = await mountScreen();
    await act(async () => { renderer.unmount(); });

    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(friendLocationCalls()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GPS watch
// ---------------------------------------------------------------------------

describe('IdleMapScreen — GPS watch', () => {
  it('does not leave a watch running when the rider leaves while it is starting', async () => {
    captureAppState();
    const remove = jest.fn();
    let handOverWatch!: (sub: { remove: jest.Mock }) => void;
    (ExpoLocation.getForegroundPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
    (ExpoLocation.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
    (ExpoLocation.watchPositionAsync as jest.Mock).mockReturnValue(
      new Promise<{ remove: jest.Mock }>((resolve) => { handOverWatch = resolve; }),
    );

    const renderer = await mountScreen();
    // Leaving while the OS is still setting the watch up is ordinary — the
    // permission dialog alone takes longer than a tap on "Browse Groups".
    await act(async () => { renderer.unmount(); });
    await act(async () => { handOverWatch({ remove }); });

    // Nothing holds a handle to this subscription any more, so if it isn't
    // released here it runs the GPS for the rest of the session.
    expect(remove).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Toast animations
// ---------------------------------------------------------------------------

describe('IdleMapScreen — toast animations', () => {
  /**
   * The two toasts are the screen's only three-step sequences (fade in, hold,
   * fade out); the other sequences under this tree (the permission prescreen,
   * the hazard picker) are two-step, so this picks them out without depending
   * on the order effects happen to fire in.
   */
  function toastSequences(spy: jest.SpyInstance): Animated.CompositeAnimation[] {
    return spy.mock.results
      .filter((_r, i) => {
        const steps = spy.mock.calls[i][0];
        return Array.isArray(steps) && steps.length === 3;
      })
      .map((r) => r.value as Animated.CompositeAnimation);
  }

  it('takes the welcome toast with it when the rider taps straight through', async () => {
    captureAppState();
    const sequence = jest.spyOn(Animated, 'sequence');
    const renderer = await mountScreen();

    const toasts = toastSequences(sequence);
    expect(toasts).toHaveLength(1); // the welcome toast, and only it, at mount
    const stop = jest.spyOn(toasts[0], 'stop');

    await act(async () => { renderer.unmount(); });

    expect(stop).toHaveBeenCalled();
  });

  it('takes the idle suggestion with it too — it starts from inside the 30s timer', async () => {
    captureAppState();
    const sequence = jest.spyOn(Animated, 'sequence');
    const renderer = await mountScreen();

    // Sit idle long enough for "Ready to roll? Find a convoy near you".
    await act(async () => { jest.advanceTimersByTime(30_000); });

    const toasts = toastSequences(sequence);
    expect(toasts).toHaveLength(2); // welcome toast + idle suggestion
    const stop = jest.spyOn(toasts[1], 'stop');

    // Clearing the idle timeout is not enough once it has already fired: the
    // ~5.7s sequence it started is still running.
    await act(async () => { renderer.unmount(); });

    expect(stop).toHaveBeenCalled();
  });
});
