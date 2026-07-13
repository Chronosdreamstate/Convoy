/**
 * Unit tests for ConvoyHistoryScreen.
 *
 * Req 19 (drive history) + Req 33 (in-motion list cap):
 *  - A failed pull-to-refresh must NOT replace already-loaded convoys with the
 *    full-screen error state — data stays with a stale-data banner instead.
 *  - While the vehicle is in motion, the list caps to 4 rows with the shared
 *    "pull over" notice.
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';
import { useMotionStore } from '../stores/motionStore';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockApiGet = jest.fn();
jest.mock('../services/apiClient', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}));

const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ groupId: 'g-1', groupName: 'Canyon Crew' }),
  useRouter: () => ({ back: jest.fn(), push: mockRouterPush, replace: jest.fn() }),
}));

import ConvoyHistoryScreen from './ConvoyHistoryScreen';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDrives(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `d-${i}`,
    groupId: 'g-1',
    distanceM: 10_000 + i,
    durationS: 1_200,
    avgSpeedKph: 60,
    topSpeedKph: 100,
    memberCount: 4,
    startedAt: `2026-07-0${(i % 7) + 1}T10:00:00.000Z`,
    endedAt: `2026-07-0${(i % 7) + 1}T10:20:00.000Z`,
  }));
}

async function renderScreen(): Promise<ReactTestInstance> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ConvoyHistoryScreen />);
  });
  return renderer.root;
}

/**
 * Distinct rendered drive rows. Composite touchables render their props on
 * both the component node and its host view, so nodes are deduped by label.
 */
function replayButtons(root: ReactTestInstance): string[] {
  const labels = root
    .findAll(
      (n) => typeof n.props?.accessibilityLabel === 'string'
        && n.props.accessibilityLabel.startsWith('Replay drive')
        && typeof n.props?.onPress === 'function',
    )
    .map((n) => n.props.accessibilityLabel as string);
  return [...new Set(labels)];
}

/** True if any Text node's flattened children join to exactly this string. */
function hasText(root: ReactTestInstance, text: string): boolean {
  return root.findAll((n) => {
    const children = n.props?.children;
    const joined = Array.isArray(children) ? children.join('') : children;
    return joined === text;
  }).length > 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  useMotionStore.setState({ isInMotion: false });
  mockApiGet.mockReset();
});

describe('ConvoyHistoryScreen', () => {
  it('renders every drive while parked', async () => {
    mockApiGet.mockResolvedValue({ data: { drives: makeDrives(6) } });
    const root = await renderScreen();

    expect(replayButtons(root)).toHaveLength(6);
    expect(hasText(root, 'Pull over to see 2 more')).toBe(false);
  });

  it('caps the list to 4 rows with the pull-over notice while in motion (Req 33)', async () => {
    useMotionStore.setState({ isInMotion: true });
    mockApiGet.mockResolvedValue({ data: { drives: makeDrives(6) } });
    const root = await renderScreen();

    expect(replayButtons(root)).toHaveLength(4);
    expect(hasText(root, 'Pull over to see 2 more')).toBe(true);
  });

  it('keeps loaded convoys and shows a stale-data banner when a refresh fails', async () => {
    mockApiGet.mockResolvedValue({ data: { drives: makeDrives(3) } });
    const root = await renderScreen();
    expect(replayButtons(root)).toHaveLength(3);

    // The next fetch (pull-to-refresh) fails.
    mockApiGet.mockRejectedValue(new Error('network down'));
    const refreshControl = root.find((n) => typeof n.props?.onRefresh === 'function');
    await act(async () => { await refreshControl.props.onRefresh(); });

    // Data survives — the full-screen error state must not appear.
    expect(replayButtons(root)).toHaveLength(3);
    expect(hasText(root, "Couldn't load convoys")).toBe(false);
    expect(hasText(root, "Couldn't refresh — showing last loaded data")).toBe(true);
  });

  it('shows the full-screen error state only when nothing is loaded', async () => {
    mockApiGet.mockRejectedValue(new Error('network down'));
    const root = await renderScreen();

    expect(hasText(root, "Couldn't load convoys")).toBe(true);
    expect(replayButtons(root)).toHaveLength(0);
  });
});
