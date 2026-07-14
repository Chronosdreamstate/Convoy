/**
 * Unit tests for SearchScreen's group-join flow.
 *
 * Req 7.3 (browse/search + join) user stories:
 *  - Joining an open group navigates into it on success — and on 409
 *    (already a member), where the join is effectively done.
 *  - A hard failure (offline, group ended/expired) must NOT silently dump the
 *    user on the group screen as if the join worked; it alerts and stays put.
 *  - The search-error retry label sits on the accent fill, so it must use the
 *    fixed ON_ACCENT white, not colors.text (near-black in light mode).
 *  - Req 33: while the vehicle is in motion, the visible result list caps to
 *    4 rows with the shared "pull over" notice.
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Alert, StyleSheet } from 'react-native';
import { useMotionStore } from '../stores/motionStore';

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

const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockRouterPush, back: jest.fn(), replace: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import SearchScreen from './SearchScreen';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OPEN_GROUP = {
  id: 'g-1',
  name: 'Sunday Rally',
  memberCount: 4,
  accessType: 'open' as const,
  nextEvent: null,
};

/**
 * Renders the screen and drives a group search through the debounce using
 * fake timers (the 100ms autofocus timeout is a no-op — host refs are null
 * under the test renderer).
 */
async function renderWithResults(groups: unknown[]): Promise<TestRenderer.ReactTestRenderer> {
  mockApiGet.mockResolvedValue({ data: { groups } });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<SearchScreen />);
  });
  const input = renderer.root.findAll(
    (n) => n.props?.accessibilityLabel === 'Search groups and people' && typeof n.props?.onChangeText === 'function',
  )[0];
  await act(async () => { input.props.onChangeText('rally'); });
  await act(async () => { jest.advanceTimersByTime(350); });
  await act(async () => {});
  return renderer;
}

/** First pressable node with this accessibility label (deduped composite/host). */
function byLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const node = root.findAll(
    (n) => n.props?.accessibilityLabel === label && typeof n.props?.onPress === 'function',
  )[0];
  expect(node).toBeDefined();
  return node;
}

/**
 * Distinct rendered group-result rows, identified by their Join buttons.
 * Composite touchables render their props on both the component node and its
 * host view, so nodes are deduped by label.
 */
function joinButtons(root: ReactTestInstance): string[] {
  const labels = root
    .findAll(
      (n) => typeof n.props?.accessibilityLabel === 'string'
        && n.props.accessibilityLabel.startsWith('Join ')
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

function makeGroups(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `g-${i}`,
    name: `Rally ${i}`,
    memberCount: 4 + i,
    accessType: 'open' as const,
    nextEvent: null,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(async () => {
  jest.useFakeTimers();
  useMotionStore.setState({ isInMotion: false });
  mockApiGet.mockReset();
  mockApiPost.mockReset();
  mockRouterPush.mockReset();
  await AsyncStorage.clear();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('SearchScreen — join flow honesty', () => {
  it('navigates into the group when the join succeeds', async () => {
    const renderer = await renderWithResults([OPEN_GROUP]);
    mockApiPost.mockResolvedValue({ data: { success: true } });

    await act(async () => { byLabel(renderer.root, 'Join Sunday Rally').props.onPress(); });

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/groups/g-1/members', {});
    expect(mockRouterPush).toHaveBeenCalledWith('/group/g-1');
  });

  it('navigates on 409 — already a member is an effective success', async () => {
    const renderer = await renderWithResults([OPEN_GROUP]);
    mockApiPost.mockRejectedValue({ status: 409 });

    await act(async () => { byLabel(renderer.root, 'Join Sunday Rally').props.onPress(); });

    expect(mockRouterPush).toHaveBeenCalledWith('/group/g-1');
  });

  it('a hard failure alerts and does NOT navigate as if the join worked', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = await renderWithResults([OPEN_GROUP]);
    mockApiPost.mockRejectedValue({ status: 500 });

    await act(async () => { byLabel(renderer.root, 'Join Sunday Rally').props.onPress(); });

    expect(alertSpy).toHaveBeenCalledWith('Could not join', expect.stringContaining('try again'));
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('a 410 (group expired/ended) explains why instead of navigating', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = await renderWithResults([OPEN_GROUP]);
    mockApiPost.mockRejectedValue({ status: 410 });

    await act(async () => { byLabel(renderer.root, 'Join Sunday Rally').props.onPress(); });

    expect(alertSpy).toHaveBeenCalledWith('Could not join', 'This group is no longer accepting new members.');
    expect(mockRouterPush).not.toHaveBeenCalled();
  });
});

describe('SearchScreen — in-motion list cap (Req 33)', () => {
  it('renders every result while parked', async () => {
    const renderer = await renderWithResults(makeGroups(6));

    expect(joinButtons(renderer.root)).toHaveLength(6);
    expect(hasText(renderer.root, 'Pull over to see 2 more')).toBe(false);
  });

  it('caps the visible results to 4 rows with the pull-over notice while in motion', async () => {
    useMotionStore.setState({ isInMotion: true });
    const renderer = await renderWithResults(makeGroups(6));

    expect(joinButtons(renderer.root)).toHaveLength(4);
    expect(hasText(renderer.root, 'Pull over to see 2 more')).toBe(true);
  });
});

describe('SearchScreen — error state contrast', () => {
  it('the retry label uses ON_ACCENT white on the accent fill (light-mode contrast)', async () => {
    mockApiGet.mockRejectedValue(new Error('offline'));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<SearchScreen />);
    });
    const input = renderer.root.findAll(
      (n) => n.props?.accessibilityLabel === 'Search groups and people' && typeof n.props?.onChangeText === 'function',
    )[0];
    await act(async () => { input.props.onChangeText('rally'); });
    await act(async () => { jest.advanceTimersByTime(350); });
    await act(async () => {});

    const retryText = renderer.root.findAll(
      (n) => n.props?.children === 'Try Again' && n.props?.style !== undefined,
    )[0];
    expect(retryText).toBeDefined();
    expect((StyleSheet.flatten(retryText.props.style) as { color?: string }).color).toBe('#FFFFFF');
  });
});
