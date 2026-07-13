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

function makeMembers(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    rank: i + 1,
    userId: `u-${i + 1}`,
    displayName: `Driver ${i + 1}`,
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
