/**
 * Unit tests for JoinByCodeScreen's join outcomes.
 *
 * Req 7.4/7.5/38.1 user stories:
 *  - Invalid (404), invite-only (403), expired (410 — server message shown
 *    verbatim), and already-joined (409) codes each get a specific inline
 *    error instead of a silent failure or a generic alert.
 *  - A successful join populates the group store (ConvoyLobbyScreen reads
 *    adminId from it) and replaces to the lobby.
 *  - The Join button label sits on the accent fill, so it must use the fixed
 *    ON_ACCENT white, not colors.text (near-black in light mode).
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';
import { StyleSheet } from 'react-native';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockApiPost = jest.fn();
jest.mock('../services/apiClient', () => ({
  apiClient: {
    post: (...args: unknown[]) => mockApiPost(...args),
  },
}));

jest.mock('../services/HapticService', () => ({
  HapticService: { trigger: jest.fn() },
}));

const mockRouterReplace = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ replace: mockRouterReplace, back: jest.fn(), push: jest.fn() }),
}));

import JoinByCodeScreen from './JoinByCodeScreen';
import { useGroupStore } from '../stores/groupStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function renderScreen(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<JoinByCodeScreen />);
  });
  return renderer;
}

/** Types a full code and presses Join. */
async function join(root: ReactTestInstance, code = 'ABC123'): Promise<void> {
  const input = root.findAll(
    (n) => n.props?.accessibilityLabel === 'Convoy join code' && typeof n.props?.onChangeText === 'function',
  )[0];
  await act(async () => { input.props.onChangeText(code); });
  const btn = root.findAll(
    (n) => n.props?.accessibilityLabel === 'Join convoy' && typeof n.props?.onPress === 'function',
  )[0];
  await act(async () => { btn.props.onPress(); });
}

/** True if any Text node's flattened children join to exactly this string. */
function hasText(root: ReactTestInstance, text: string): boolean {
  return root.findAll((n) => {
    const children = n.props?.children;
    if (children === undefined || children === null) return false;
    const joined = Array.isArray(children) ? children.join('') : String(children);
    return joined === text;
  }).length > 0;
}

function rejectWith(status: number, message?: string) {
  mockApiPost.mockRejectedValue({ response: { status, data: message ? { message } : {} } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockApiPost.mockReset();
  mockRouterReplace.mockReset();
  useGroupStore.setState({ activeGroupId: null });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('JoinByCodeScreen — join outcomes', () => {
  it('a successful join populates the group store and replaces to the lobby', async () => {
    mockApiPost.mockResolvedValue({ data: { id: 'g-1', name: 'Sunday Rally', adminId: 'u-9' } });
    const renderer = await renderScreen();

    await join(renderer.root);

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/groups/join', { code: 'ABC123' });
    expect(useGroupStore.getState().activeGroupId).toBe('g-1');
    expect(mockRouterReplace).toHaveBeenCalledWith({
      pathname: '/lobby/[groupId]',
      params: { groupId: 'g-1', name: 'Sunday Rally' },
    });
  });

  it('an unknown code (404) shows a specific inline error', async () => {
    rejectWith(404);
    const renderer = await renderScreen();

    await join(renderer.root);

    expect(hasText(renderer.root, 'Code not found — check with your convoy leader')).toBe(true);
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it("joining a group you're already in (409) says so", async () => {
    rejectWith(409);
    const renderer = await renderScreen();

    await join(renderer.root);

    expect(hasText(renderer.root, "You're already in this group")).toBe(true);
  });

  it('an expired code (410) surfaces the server message verbatim', async () => {
    rejectWith(410, 'This join code has expired due to group inactivity');
    const renderer = await renderScreen();

    await join(renderer.root);

    expect(hasText(renderer.root, 'This join code has expired due to group inactivity')).toBe(true);
  });
});

describe('JoinByCodeScreen — accent contrast', () => {
  it('Join button label uses ON_ACCENT white on the accent fill (light-mode contrast)', async () => {
    const renderer = await renderScreen();
    const joinText = renderer.root.findAll(
      (n) => n.props?.children === 'Join Convoy' && n.props?.style !== undefined,
    )[0];
    expect(joinText).toBeDefined();
    expect((StyleSheet.flatten(joinText.props.style) as { color?: string }).color).toBe('#FFFFFF');
  });
});
