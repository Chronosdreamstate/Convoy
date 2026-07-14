/**
 * Unit tests for GroupLeaderboardScreen.
 *
 * Req 32 (leaderboard) + Req 33 (in-motion list cap):
 *  - While the vehicle is in motion, the rankings cap to 4 rows with the
 *    shared "pull over" notice; ranks stay stable because the cap keeps
 *    order from the top.
 *  - The active metric tab sits on the accent fill, so its label must use the
 *    fixed ON_ACCENT white — colors.text flips to near-black in light mode
 *    and would be unreadable there.
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';
import { StyleSheet } from 'react-native';
import { useMotionStore } from '../stores/motionStore';
import { useAuthStore, User } from '../stores/authStore';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

const mockApiGet = jest.fn();
jest.mock('../services/apiClient', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}));

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ groupId: 'g-1' }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
}));

import GroupLeaderboardScreen from './GroupLeaderboardScreen';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ME: User = { id: 'u-1', displayName: 'Me', privacy: 'open' };

/**
 * Ranked members u-{startId} .. u-{startId+count-1}. Pass startId > 1 to build
 * a top-N page that does NOT contain the signed-in user (ME is u-1).
 */
function makeMembers(count: number, startId = 1) {
  return Array.from({ length: count }, (_, i) => ({
    rank: i + 1,
    userId: `u-${startId + i}`,
    displayName: `Driver ${startId + i}`,
    callsign: null,
    avatarUrl: null,
    totalDistanceKm: 100 - i,
    driveCount: 10 - i,
    totalDurationMin: 500 - i,
    value: 100 - i,
  }));
}

async function renderScreen(): Promise<ReactTestInstance> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<GroupLeaderboardScreen />);
  });
  return renderer.root;
}

/**
 * Distinct rendered ranking rows. Composite components can render their props
 * on both the component node and its host view, so nodes are deduped by label.
 */
function memberRows(root: ReactTestInstance): string[] {
  const labels = root
    .findAll(
      (n) => typeof n.props?.accessibilityLabel === 'string'
        && /^Rank \d+:/.test(n.props.accessibilityLabel),
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

/** Deduped accessibility labels of pinned "Your rank" bars (0 or 1 expected). */
function pinnedRankLabels(root: ReactTestInstance): string[] {
  const labels = root
    .findAll(
      (n) => typeof n.props?.accessibilityLabel === 'string'
        && n.props.accessibilityLabel.startsWith('Your rank:'),
    )
    .map((n) => n.props.accessibilityLabel as string);
  return [...new Set(labels)];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  useMotionStore.setState({ isInMotion: false });
  useAuthStore.setState({ user: ME });
  mockApiGet.mockReset();
});

describe('GroupLeaderboardScreen', () => {
  it('renders every ranked member while parked', async () => {
    mockApiGet.mockResolvedValue({ data: { leaderboard: makeMembers(6) } });
    const root = await renderScreen();

    expect(memberRows(root)).toHaveLength(6);
    expect(hasText(root, 'Pull over to see 2 more')).toBe(false);
  });

  it('caps the rankings to 4 rows with the pull-over notice while in motion (Req 33)', async () => {
    useMotionStore.setState({ isInMotion: true });
    mockApiGet.mockResolvedValue({ data: { leaderboard: makeMembers(6) } });
    const root = await renderScreen();

    const rows = memberRows(root);
    expect(rows).toHaveLength(4);
    // Order from the top is preserved — rank 1 is still first.
    expect(rows[0]).toContain('Rank 1:');
    expect(hasText(root, 'Pull over to see 2 more')).toBe(true);
  });

  it('renders the active tab label in fixed ON_ACCENT white on the accent fill', async () => {
    mockApiGet.mockResolvedValue({ data: { leaderboard: makeMembers(2) } });
    const root = await renderScreen();

    // "Distance" is the default active tab.
    const activeTab = root.find(
      (n) => n.props?.accessibilityRole === 'tab' && n.props?.accessibilityState?.selected === true,
    );
    const label = activeTab.find((n) => n.props?.children === 'Distance');
    expect(StyleSheet.flatten(label.props.style).color).toBe('#FFFFFF');
  });
});

describe('GroupLeaderboardScreen — pinned "your rank" row', () => {
  it('renders the pinned row when the user is outside the fetched top-N', async () => {
    // Page contains u-2..u-21; the signed-in user (u-1) is ranked #47 overall.
    mockApiGet.mockResolvedValue({
      data: { leaderboard: makeMembers(20, 2), me: { rank: 47, value: 12 } },
    });
    const root = await renderScreen();

    expect(pinnedRankLabels(root)).toEqual(['Your rank: 47, 12 km']);
    expect(hasText(root, '#47')).toBe(true);
  });

  it('does not duplicate the pinned row when the user IS in the top-N', async () => {
    // u-1 is rank 1 in the page; server still mirrors `me` for in-list users.
    mockApiGet.mockResolvedValue({
      data: { leaderboard: makeMembers(6), me: { rank: 1, value: 100 } },
    });
    const root = await renderScreen();

    // In-list row is rendered with the YOU marker; no pinned bar underneath.
    expect(memberRows(root).some((l) => l.includes(', you,'))).toBe(true);
    expect(pinnedRankLabels(root)).toHaveLength(0);
  });

  it('renders no pinned row when me is null (user has no ranked data)', async () => {
    mockApiGet.mockResolvedValue({
      data: { leaderboard: makeMembers(6, 2), me: null },
    });
    const root = await renderScreen();

    expect(pinnedRankLabels(root)).toHaveLength(0);
  });

  it('renders no pinned row when me is absent (older API)', async () => {
    mockApiGet.mockResolvedValue({ data: { leaderboard: makeMembers(6, 2) } });
    const root = await renderScreen();

    expect(pinnedRankLabels(root)).toHaveLength(0);
  });

  it('pins the rank when the Req 33 motion cap hides the user\'s in-list row', async () => {
    // u-6 is inside the fetched page (rank 6) but the in-motion cap only
    // shows 4 rows — their own row disappears, so the pinned bar must appear.
    useMotionStore.setState({ isInMotion: true });
    useAuthStore.setState({ user: { ...ME, id: 'u-6' } });
    mockApiGet.mockResolvedValue({
      data: { leaderboard: makeMembers(6), me: { rank: 6, value: 95 } },
    });
    const root = await renderScreen();

    expect(memberRows(root)).toHaveLength(4);
    expect(pinnedRankLabels(root)).toEqual(['Your rank: 6, 95 km']);
  });

  it('keeps the pinned row hidden while in motion if the user survives the cap', async () => {
    useMotionStore.setState({ isInMotion: true });
    // u-1 is rank 1 — still visible among the 4 capped rows.
    mockApiGet.mockResolvedValue({
      data: { leaderboard: makeMembers(6), me: { rank: 1, value: 100 } },
    });
    const root = await renderScreen();

    expect(memberRows(root)).toHaveLength(4);
    expect(pinnedRankLabels(root)).toHaveLength(0);
  });
});
