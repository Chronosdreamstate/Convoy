/**
 * Unit tests for GroupSettingsScreen.
 *
 * Req 34.1 (driver distraction — multi-step flow blocking) + settings stories:
 *  - Editing group settings is an explicitly-blocked flow while in motion.
 *    Entry is guarded in ConvoyScreen, but motion can begin while this screen
 *    is already open — Save and the Schedule-a-Convoy entry re-check at tap
 *    time and show the "Park to continue" prompt without mutating anything.
 *  - While parked, Save PATCHes the drafted settings.
 *  - The Save label sits on the accent fill, so it must use the fixed
 *    ON_ACCENT white, not colors.text (near-black in light mode).
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Alert, StyleSheet } from 'react-native';
import { useMotionStore } from '../stores/motionStore';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockApiGet = jest.fn();
const mockApiPatch = jest.fn();
const mockApiPost = jest.fn();
jest.mock('../services/apiClient', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockApiGet(...args),
    patch: (...args: unknown[]) => mockApiPatch(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
  },
}));

const mockRouterPush = jest.fn();
let mockParams: { groupId?: string; isAdmin?: string } = { groupId: 'g-1', isAdmin: 'true' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ push: mockRouterPush, back: jest.fn(), replace: jest.fn() }),
}));

import GroupSettingsScreen from './GroupSettingsScreen';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function renderScreen(): Promise<TestRenderer.ReactTestRenderer> {
  mockApiGet.mockImplementation((url: string) => {
    if (url === '/api/v1/groups/g-1') {
      return Promise.resolve({
        data: { id: 'g-1', name: 'Sunday Rally', gapThresholdM: 1000, pttMaxSeconds: 30, accessType: 'open' },
      });
    }
    if (url === '/api/v1/groups/g-1/members') {
      return Promise.resolve({ data: { members: [] } });
    }
    if (url === '/api/v1/groups/g-1/join-requests') {
      return Promise.resolve({ data: { requests: [] } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });

  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<GroupSettingsScreen />);
  });
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  useMotionStore.setState({ isInMotion: false });
  mockApiGet.mockReset();
  mockApiPatch.mockReset();
  mockApiPost.mockReset();
  mockRouterPush.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GroupSettingsScreen — Req 34 in-motion guard', () => {
  it('Save while in motion shows "Park to continue" and does not PATCH', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = await renderScreen();

    await act(async () => { useMotionStore.setState({ isInMotion: true }); });
    await act(async () => { byLabel(renderer.root, 'Save group settings').props.onPress(); });

    expect(alertSpy).toHaveBeenCalledWith('Park to continue', expect.stringContaining('park'));
    expect(mockApiPatch).not.toHaveBeenCalled();
  });

  it('Schedule a Convoy while in motion is blocked and does not navigate', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const renderer = await renderScreen();

    await act(async () => { useMotionStore.setState({ isInMotion: true }); });
    await act(async () => { byLabel(renderer.root, 'Schedule convoy event').props.onPress(); });

    expect(alertSpy).toHaveBeenCalledWith('Park to continue', expect.anything());
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('Save while parked PATCHes the drafted settings', async () => {
    mockApiPatch.mockResolvedValue({ data: {} });
    const renderer = await renderScreen();

    await act(async () => { byLabel(renderer.root, 'Save group settings').props.onPress(); });

    expect(mockApiPatch).toHaveBeenCalledWith('/api/v1/groups/g-1/settings', {
      name: 'Sunday Rally',
      gapThresholdM: 1000,
      pttMaxSeconds: 30,
      accessType: 'open',
    });
  });
});

describe('GroupSettingsScreen — accent contrast', () => {
  it('Save label uses ON_ACCENT white on the accent fill (light-mode contrast)', async () => {
    const renderer = await renderScreen();
    const saveText = renderer.root.findAll(
      (n) => n.props?.children === 'Save Changes' && n.props?.style !== undefined,
    )[0];
    expect(saveText).toBeDefined();
    expect((StyleSheet.flatten(saveText.props.style) as { color?: string }).color).toBe('#FFFFFF');
  });
});

// ---------------------------------------------------------------------------
// Failure path: opened with no group id
// ---------------------------------------------------------------------------

describe('GroupSettingsScreen — opened without a group', () => {
  afterEach(() => {
    mockParams = { groupId: 'g-1', isAdmin: 'true' };
  });

  it('shows a dead-end instead of a skeleton that never resolves', async () => {
    // /group-settings is a static route whose groupId rides in the query
    // string, so a deep link (or a navigation that dropped its params) lands
    // here with nothing to fetch. loadSettings bails and `loading` starts true
    // — the screen used to sit on its skeleton forever.
    mockParams = { isAdmin: 'true' };
    mockApiGet.mockImplementation((url: string) => Promise.reject(new Error(`unexpected GET ${url}`)));

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<GroupSettingsScreen />); });
    await act(async () => {});

    expect(mockApiGet).not.toHaveBeenCalled();

    const text: string[] = [];
    const walk = (node: unknown): void => {
      if (node == null) return;
      if (typeof node === 'string') { text.push(node); return; }
      if (Array.isArray(node)) { node.forEach(walk); return; }
      walk((node as { children?: unknown }).children);
    };
    walk(renderer.toJSON());
    const rendered = text.join(' ');

    expect(rendered).toContain('Settings unavailable');
    expect(rendered).toContain('This link is missing its group.');
    // No editable form for a group that doesn't exist, and a way back remains.
    expect(rendered).not.toContain('Save Changes');
    expect(byLabel(renderer.root, 'Go back')).toBeDefined();

    renderer.unmount();
  });
});

/**
 * Rows built from other people's payloads.
 *
 * Both member rows derived their avatar letter inline with
 * `displayName.trim()[0]` — a 200 that omitted the field took the whole
 * screen down with "Cannot read properties of undefined (reading 'trim')",
 * the same crash a render-smoke sweep already found live on UserProfileScreen
 * and app/invite.tsx. Both now go through utils/avatar's guarded `initials`.
 *
 * The rows also have to survive a *long* name: display names run to 50
 * characters (longer for the ones the API mints from an email local part at
 * sign-up), and the Approve/Decline buttons and the transfer chevron are
 * siblings of the name column.
 */
describe('GroupSettingsScreen — member rows built from other people’s names', () => {
  const LONG_NAME = 'A'.repeat(60);

  async function renderWithPeople(members: unknown[], requests: unknown[]) {
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/v1/groups/g-1') {
        return Promise.resolve({
          data: { id: 'g-1', name: 'Sunday Rally', gapThresholdM: 1000, pttMaxSeconds: 30, accessType: 'open' },
        });
      }
      if (url === '/api/v1/groups/g-1/members') return Promise.resolve({ data: { members } });
      if (url === '/api/v1/groups/g-1/join-requests') return Promise.resolve({ data: { requests } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<GroupSettingsScreen />); });
    await act(async () => {});
    return renderer;
  }

  /** Every Text node rendering exactly `value`. */
  function textsFor(root: ReactTestInstance, value: string): ReactTestInstance[] {
    return root.findAll((n) => {
      const c = n.props?.children;
      return (Array.isArray(c) ? c.join('') : c) === value && n.props?.numberOfLines !== undefined;
    });
  }

  it('renders a member and a join request whose payload carries no displayName', async () => {
    const renderer = await renderWithPeople(
      [{ userId: 'u-2', isAdmin: false, pttCallsign: null }],
      [{ id: 'r-1', callsign: null }],
    );

    // Got here at all = no throw out of render. Both avatars show the
    // explicit '?' fallback rather than an empty bubble.
    const fallbacks = renderer.root.findAll((n) => {
      const c = n.props?.children;
      return (Array.isArray(c) ? c.join('') : c) === '?';
    });
    expect(fallbacks.length).toBeGreaterThan(0);
  });

  it('keeps a 60-character name to one line in both rows', async () => {
    const renderer = await renderWithPeople(
      [{ userId: 'u-2', displayName: LONG_NAME, isAdmin: false, pttCallsign: null }],
      [{ id: 'r-1', displayName: LONG_NAME, callsign: null }],
    );

    const nameNodes = textsFor(renderer.root, LONG_NAME);
    // One in the transfer-admin row, one in the join-request row.
    expect(nameNodes.length).toBeGreaterThanOrEqual(2);
    for (const node of nameNodes) {
      expect(node.props.numberOfLines).toBe(1);
    }
  });
});
