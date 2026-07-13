/**
 * Unit tests for RouteReplayScreen's playback engine.
 *
 * Req 19 (route replay) + Req 39–41 (reduce motion):
 *  - Continuous playback advances the marker point-by-point and the seek bar
 *    reports honest progress (pause really pauses, completion flips back to
 *    Play).
 *  - Under OS reduce-motion, playback switches to the stepped equivalent —
 *    discrete ~REDUCE_MOTION_STEPS jumps once per second instead of the
 *    ~20 fps continuous sweep — while still reaching the end of the route.
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('react-native-maps', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');
  const MapView = ReactActual.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    ReactActual.useImperativeHandle(ref, () => ({ fitToCoordinates: jest.fn() }));
    return ReactActual.createElement(View, props, props.children as React.ReactNode);
  });
  const Passthrough = (props: Record<string, unknown>) =>
    ReactActual.createElement(View, props, props.children as React.ReactNode);
  return { __esModule: true, default: MapView, Marker: Passthrough, Polyline: Passthrough };
});

const mockApiGet = jest.fn();
const mockApiPost = jest.fn();
jest.mock('../services/apiClient', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
  },
}));

const mockRouterBack = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ driveId: 'drive-1' }),
  useRouter: () => ({ back: mockRouterBack, push: jest.fn(), replace: jest.fn() }),
}));

let mockReduceMotion = false;
jest.mock('../hooks/useReduceMotion', () => ({
  useReduceMotion: () => mockReduceMotion,
}));

import RouteReplayScreen, { REDUCE_MOTION_STEPS } from './RouteReplayScreen';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 41 coordinates → 40 intervals, so stepped stride = ceil(40 / 20) = 2. */
const POINT_COUNT = 41;

function makeDrive() {
  return {
    id: 'drive-1',
    routeTrace: {
      type: 'LineString',
      coordinates: Array.from({ length: POINT_COUNT }, (_, i) => [10 + i * 0.001, 50 + i * 0.001]),
    },
    distanceM: 12_000,
    durationS: 600,
    avgSpeedKph: 72,
    topSpeedKph: 110,
    startedAt: '2026-07-01T10:00:00.000Z',
    endedAt: '2026-07-01T10:10:00.000Z',
    memberCount: 3,
  };
}

async function renderScreen(): Promise<{ root: ReactTestInstance; renderer: TestRenderer.ReactTestRenderer }> {
  mockApiGet.mockResolvedValue({ data: makeDrive() });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<RouteReplayScreen />);
  });
  return { root: renderer.root, renderer };
}

function seekBar(root: ReactTestInstance): ReactTestInstance {
  return root.find((n) => n.props?.accessibilityLabel === 'Seek replay position');
}

function progressNow(root: ReactTestInstance): number {
  return seekBar(root).props.accessibilityValue.now as number;
}

function pressButton(root: ReactTestInstance, label: string): void {
  const btn = root.find((n) => n.props?.accessibilityLabel === label && typeof n.props?.onPress === 'function');
  act(() => { btn.props.onPress(); });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.useFakeTimers();
  mockReduceMotion = false;
  mockApiGet.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('RouteReplayScreen playback', () => {
  it('advances one point per 50 ms tick in continuous mode', async () => {
    const { root } = await renderScreen();

    expect(progressNow(root)).toBe(0);
    pressButton(root, 'Play');

    // One tick = one point of 40 intervals → 2.5% → rounds to 3.
    act(() => { jest.advanceTimersByTime(50); });
    expect(progressNow(root)).toBe(3);

    act(() => { jest.advanceTimersByTime(50 * 19); });
    expect(progressNow(root)).toBe(50);
  });

  it('pause really pauses — no further progress while stopped', async () => {
    const { root } = await renderScreen();

    pressButton(root, 'Play');
    act(() => { jest.advanceTimersByTime(50 * 10); });
    const atPause = progressNow(root);

    pressButton(root, 'Pause');
    act(() => { jest.advanceTimersByTime(5_000); });
    expect(progressNow(root)).toBe(atPause);
  });

  it('reaches 100% and flips back to Play on completion', async () => {
    const { root } = await renderScreen();

    pressButton(root, 'Play');
    // 40 intervals * 50 ms, plus one extra tick of slack.
    act(() => { jest.advanceTimersByTime(50 * (POINT_COUNT + 1)); });

    expect(progressNow(root)).toBe(100);
    // Playback stopped — the toggle is labelled Play again.
    expect(
      root.findAll((n) => n.props?.accessibilityLabel === 'Play' && typeof n.props?.onPress === 'function'),
    ).toHaveLength(1);
  });

  it('steps in discrete once-per-second jumps under OS reduce-motion', async () => {
    mockReduceMotion = true;
    const { root } = await renderScreen();

    pressButton(root, 'Play');

    // No continuous 50 ms ticks — nothing moves before the 1 s step lands.
    act(() => { jest.advanceTimersByTime(999); });
    expect(progressNow(root)).toBe(0);

    // First step: stride = ceil(40 / REDUCE_MOTION_STEPS) = 2 points → 5%.
    const stridePct = Math.round((Math.ceil((POINT_COUNT - 1) / REDUCE_MOTION_STEPS) / (POINT_COUNT - 1)) * 100);
    act(() => { jest.advanceTimersByTime(1); });
    expect(progressNow(root)).toBe(stridePct);

    // Stepped playback still reaches the end of the route and stops.
    act(() => { jest.advanceTimersByTime(1_000 * (REDUCE_MOTION_STEPS + 1)); });
    expect(progressNow(root)).toBe(100);
    expect(
      root.findAll((n) => n.props?.accessibilityLabel === 'Play' && typeof n.props?.onPress === 'function'),
    ).toHaveLength(1);
  });
});
