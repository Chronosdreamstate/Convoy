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
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ groupId: 'g-1', isAdmin: 'true' }),
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
