/**
 * Unit tests for GroupStatsScreen.
 *
 * Req 20 (group stats) user stories:
 *  - The share tap must await Share.share and swallow its rejection — a failed
 *    share sheet must never surface as an unhandled promise rejection.
 *  - A failed pull-to-refresh must NOT replace already-loaded stats with the
 *    full-screen error state — data stays with a stale-data banner instead.
 *  - Opening the screen without a group id param is a dead-end (broken link),
 *    not a skeleton that spins forever.
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Share } from 'react-native';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockApiGet = jest.fn();
jest.mock('../services/apiClient', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}));

let mockParams: Record<string, string> = { id: 'g-1' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
}));

import GroupStatsScreen from './GroupStatsScreen';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATS = {
  groupName: 'Canyon Crew',
  totalDriveKm: 420.5,
  totalDrives: 12,
  totalMembers: 8,
  avgConvoyDurationMin: 45.2,
  longestConvoyKm: 88.1,
  topMembers: [],
  monthlyDrives: [],
};

async function renderScreen(): Promise<ReactTestInstance> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<GroupStatsScreen />);
  });
  return renderer.root;
}

/** First pressable node with this accessibility label (deduped composite/host). */
function byLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const node = root.findAll(
    (n) => n.props?.accessibilityLabel === label && typeof n.props?.onPress === 'function',
  )[0];
  expect(node).toBeDefined();
  return node;
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
  mockApiGet.mockReset();
  mockParams = { id: 'g-1' };
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GroupStatsScreen — share', () => {
  it('invokes Share.share with the crew brag message', async () => {
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.dismissedAction });
    mockApiGet.mockResolvedValue({ data: STATS });
    const root = await renderScreen();

    await act(async () => { byLabel(root, 'Share group stats').props.onPress(); });

    expect(shareSpy).toHaveBeenCalledWith({
      message: expect.stringContaining('421 km together in 12 convoys'),
    });
  });

  it('a rejected share sheet is awaited and swallowed — no unhandled rejection', async () => {
    jest.spyOn(Share, 'share').mockRejectedValue(new Error('sheet unavailable'));
    mockApiGet.mockResolvedValue({ data: STATS });
    const root = await renderScreen();

    // If handleShare didn't await/catch, this act would surface the rejection
    // and fail the test.
    await act(async () => { byLabel(root, 'Share group stats').props.onPress(); });

    // The screen is still alive and rendering after the failed share.
    expect(hasText(root, 'Canyon Crew')).toBe(true);
  });
});

describe('GroupStatsScreen — load/refresh states', () => {
  it('keeps loaded stats and shows a stale-data banner when a refresh fails', async () => {
    mockApiGet.mockResolvedValue({ data: STATS });
    const root = await renderScreen();
    expect(hasText(root, 'Canyon Crew')).toBe(true);

    // The next fetch (pull-to-refresh) fails.
    mockApiGet.mockRejectedValue(new Error('network down'));
    const refreshControl = root.find((n) => typeof n.props?.onRefresh === 'function');
    await act(async () => { await refreshControl.props.onRefresh(); });

    // Data survives — the full-screen error state must not appear.
    expect(hasText(root, 'Canyon Crew')).toBe(true);
    expect(hasText(root, "Couldn't refresh — showing last loaded data")).toBe(true);
  });

  it('shows the full-screen error state only when nothing is loaded', async () => {
    mockApiGet.mockRejectedValue(new Error('network down'));
    const root = await renderScreen();

    expect(hasText(root, 'Could not load stats.')).toBe(true);
  });

  it('a missing group id param is an explicit dead-end, not an endless skeleton', async () => {
    mockParams = {};
    const root = await renderScreen();

    // No fetch can ever succeed without an id — nothing should be requested.
    expect(mockApiGet).not.toHaveBeenCalled();
    expect(hasText(root, 'Stats unavailable')).toBe(true);
    // The way back is offered instead of a retry that would be a lie.
    byLabel(root, 'Go back to previous screen');
  });
});
