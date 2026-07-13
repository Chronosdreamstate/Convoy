/**
 * Unit tests for UserProfileScreen's relationship states.
 *
 * Req 17.11 (blocking) + the profile user stories:
 *  - A user the viewer has blocked shows an honest Blocked state with an
 *    Unblock action — never a dead "Add Friend" button the server would
 *    reject. Unblocking restores the normal action row.
 *  - A stranger gets the Add Friend flow; sending flips it to Request Sent.
 *  - The Add Friend label sits on the accent fill, so it must use the fixed
 *    ON_ACCENT white, not colors.text (near-black in light mode).
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';
import { StyleSheet } from 'react-native';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
  useLocalSearchParams: () => ({ userId: 'u-2' }),
  useRouter: () => ({ back: mockRouterBack, push: jest.fn(), replace: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

import UserProfileScreen from './UserProfileScreen';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function profile(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'u-2',
    displayName: 'Blocked Bob',
    avatarUrl: null,
    callsign: null,
    bio: null,
    memberSince: '2024-01-01T00:00:00.000Z',
    vehicleType: null,
    vehicleMake: null,
    vehicleModel: null,
    vehicleYear: null,
    vehicleColor: null,
    mods: [],
    totalDrives: 3,
    totalDistanceKm: 120,
    mutualFriends: 0,
    friendStatus: null,
    ...overrides,
  };
}

async function renderScreen(friendStatus: string | null): Promise<TestRenderer.ReactTestRenderer> {
  mockApiGet.mockResolvedValue({ data: profile({ friendStatus }) });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<UserProfileScreen />);
  });
  await act(async () => {});
  return renderer;
}

/** First pressable node with this accessibility label (deduped composite/host). */
function byLabel(root: ReactTestInstance, label: string): ReactTestInstance | undefined {
  return root.findAll(
    (n) => n.props?.accessibilityLabel === label && typeof n.props?.onPress === 'function',
  )[0];
}

/** Flattened color of the Text node whose children are exactly `text`. */
function textColor(root: ReactTestInstance, text: string): string | undefined {
  const node = root.findAll((n) => {
    const children = n.props?.children;
    return children === text && n.props?.style !== undefined;
  })[0];
  if (!node) return undefined;
  return (StyleSheet.flatten(node.props.style) as { color?: string }).color;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockApiGet.mockReset();
  mockApiPost.mockReset();
  mockRouterBack.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('UserProfileScreen — blocked relationship', () => {
  it("a profile the viewer has blocked shows Unblock, never a dead Add Friend button", async () => {
    const renderer = await renderScreen('blocked');

    expect(byLabel(renderer.root, 'Unblock Blocked Bob')).toBeDefined();
    expect(byLabel(renderer.root, 'Add Friend')).toBeUndefined();
    expect(byLabel(renderer.root, 'Block Blocked Bob')).toBeUndefined();
  });

  it('unblocking calls the server and restores the normal action row', async () => {
    const renderer = await renderScreen('blocked');
    mockApiPost.mockResolvedValue({ data: { message: 'User unblocked' } });

    const unblock = byLabel(renderer.root, 'Unblock Blocked Bob')!;
    await act(async () => { unblock.props.onPress(); });

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/friends/unblock', { userId: 'u-2' });
    expect(byLabel(renderer.root, 'Add Friend')).toBeDefined();
    expect(byLabel(renderer.root, 'Block Blocked Bob')).toBeDefined();
  });
});

describe('UserProfileScreen — stranger flow', () => {
  it('Add Friend sends the request and flips to Request Sent', async () => {
    const renderer = await renderScreen(null);
    mockApiPost.mockResolvedValue({ data: {} });

    const addBtn = byLabel(renderer.root, 'Add Friend')!;
    await act(async () => { addBtn.props.onPress(); });

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/friends/requests', { addresseeId: 'u-2' });
    expect(byLabel(renderer.root, 'Request Sent')).toBeDefined();
  });

  it('Add Friend label uses ON_ACCENT white on the accent fill (light-mode contrast)', async () => {
    const renderer = await renderScreen(null);
    expect(textColor(renderer.root, 'Add Friend')).toBe('#FFFFFF');
  });
});
