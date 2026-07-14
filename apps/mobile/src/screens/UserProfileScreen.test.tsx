/**
 * Unit tests for UserProfileScreen's relationship states.
 *
 * Req 17.11 (blocking) + the profile user stories:
 *  - A user the viewer has blocked shows an honest Blocked state with an
 *    Unblock action — never a dead "Add Friend" button the server would
 *    reject. Unblocking restores the normal action row.
 *  - A stranger gets the Add Friend flow; sending flips it to a withdrawable
 *    Requested state (or straight to Friends when the server auto-accepts).
 *  - Pending requests are directional (friendRequestDirection): outgoing
 *    shows Requested + withdraw, incoming shows Accept/Decline wired to the
 *    friends request endpoints; direction-less pending (older API) keeps the
 *    legacy disabled Request Sent button.
 *  - The Add Friend label sits on the accent fill, so it must use the fixed
 *    ON_ACCENT white, not colors.text (near-black in light mode).
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Alert, StyleSheet } from 'react-native';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockApiGet = jest.fn();
const mockApiPost = jest.fn();
const mockApiDelete = jest.fn();
jest.mock('../services/apiClient', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
    delete: (...args: unknown[]) => mockApiDelete(...args),
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
    friendRequestDirection: null,
    friendRequestId: null,
    ...overrides,
  };
}

async function renderScreen(
  friendStatus: string | null,
  extra: Partial<Record<string, unknown>> = {},
): Promise<TestRenderer.ReactTestRenderer> {
  mockApiGet.mockResolvedValue({ data: profile({ friendStatus, ...extra }) });
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
  mockApiDelete.mockReset();
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
  it('Add Friend sends the request and flips to a withdrawable Requested state', async () => {
    const renderer = await renderScreen(null);
    mockApiPost.mockResolvedValue({ data: { id: 'fr-1', status: 'pending', autoAccepted: false } });

    const addBtn = byLabel(renderer.root, 'Add Friend')!;
    await act(async () => { addBtn.props.onPress(); });

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/friends/requests', { addresseeId: 'u-2' });
    expect(byLabel(renderer.root, 'Requested')).toBeDefined();
  });

  it('an auto-accepted request (open privacy) flips straight to Friends', async () => {
    const renderer = await renderScreen(null);
    mockApiPost.mockResolvedValue({ data: { id: 'fr-1', status: 'accepted', autoAccepted: true } });

    const addBtn = byLabel(renderer.root, 'Add Friend')!;
    await act(async () => { addBtn.props.onPress(); });

    expect(byLabel(renderer.root, 'Friends')).toBeDefined();
  });

  it('Add Friend label uses ON_ACCENT white on the accent fill (light-mode contrast)', async () => {
    const renderer = await renderScreen(null);
    expect(textColor(renderer.root, 'Add Friend')).toBe('#FFFFFF');
  });
});

describe('UserProfileScreen — outgoing pending request', () => {
  it("renders 'Requested' and withdraws via DELETE /friends/requests/:id", async () => {
    const renderer = await renderScreen('pending', {
      friendRequestDirection: 'outgoing',
      friendRequestId: 'fr-9',
    });
    mockApiDelete.mockResolvedValue({ data: {} });
    // Auto-confirm the withdraw dialog.
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _msg, buttons) => {
      const withdraw = buttons?.find((b) => b.text === 'Withdraw');
      withdraw?.onPress?.();
    });

    const requested = byLabel(renderer.root, 'Requested');
    expect(requested).toBeDefined();
    expect(byLabel(renderer.root, 'Accept friend request')).toBeUndefined();

    await act(async () => { requested!.props.onPress(); });

    expect(mockApiDelete).toHaveBeenCalledWith('/api/v1/friends/requests/fr-9');
    expect(byLabel(renderer.root, 'Add Friend')).toBeDefined();
  });

  it('a pending status without direction (older API) keeps the disabled Request Sent state', async () => {
    const renderer = await renderScreen('pending');

    const btn = byLabel(renderer.root, 'Request Sent');
    expect(btn).toBeDefined();
    expect(btn!.props.accessibilityState?.disabled).toBe(true);
    expect(byLabel(renderer.root, 'Requested')).toBeUndefined();
  });
});

describe('UserProfileScreen — incoming pending request', () => {
  const incoming = { friendRequestDirection: 'incoming', friendRequestId: 'fr-7' };

  it('renders Accept and Decline instead of a dead Request Sent button', async () => {
    const renderer = await renderScreen('pending', incoming);

    expect(byLabel(renderer.root, 'Accept friend request')).toBeDefined();
    expect(byLabel(renderer.root, 'Decline friend request')).toBeDefined();
    expect(byLabel(renderer.root, 'Request Sent')).toBeUndefined();
    expect(byLabel(renderer.root, 'Add Friend')).toBeUndefined();
  });

  it('Accept posts to /friends/requests/:id/accept and flips to Friends', async () => {
    const renderer = await renderScreen('pending', incoming);
    mockApiPost.mockResolvedValue({ data: { id: 'fr-7', status: 'accepted' } });

    const accept = byLabel(renderer.root, 'Accept friend request')!;
    await act(async () => { accept.props.onPress(); });

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/friends/requests/fr-7/accept');
    expect(byLabel(renderer.root, 'Friends')).toBeDefined();
  });

  it('Decline posts to /friends/requests/:id/decline and restores Add Friend', async () => {
    const renderer = await renderScreen('pending', incoming);
    mockApiPost.mockResolvedValue({ data: {} });

    const decline = byLabel(renderer.root, 'Decline friend request')!;
    await act(async () => { decline.props.onPress(); });

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/friends/requests/fr-7/decline');
    expect(byLabel(renderer.root, 'Add Friend')).toBeDefined();
  });
});
