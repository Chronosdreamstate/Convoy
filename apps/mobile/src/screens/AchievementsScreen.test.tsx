/**
 * Unit tests for AchievementsScreen.
 *
 * Req 20 (achievements) + Req 33 (in-motion list cap) + Req 39–41 (reduce motion):
 *  - While the vehicle is in motion, the badge grid caps to 4 cells with the
 *    shared "pull over" notice.
 *  - The unlocked-count header badge sits on the accent fill, so it must use
 *    the fixed ON_ACCENT white, not colors.text.
 *  - Under OS reduce-motion the detail sheet appears in place — no slide-up
 *    spring, no celebratory badge bounce.
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Animated, StyleSheet } from 'react-native';
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

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

let mockReduceMotion = false;
jest.mock('../hooks/useReduceMotion', () => ({
  useReduceMotion: () => mockReduceMotion,
}));

import AchievementsScreen from './AchievementsScreen';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function renderScreen(): Promise<ReactTestInstance> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AchievementsScreen />);
  });
  return renderer.root;
}

/**
 * Distinct rendered badge cards. Composite touchables render their props on
 * both the component node and its host view, so nodes are deduped by label —
 * pressing the first node still drives the card's onPress.
 */
function badgeCards(root: ReactTestInstance): ReactTestInstance[] {
  const seen = new Set<string>();
  return root
    .findAll(
      (n) => typeof n.props?.accessibilityLabel === 'string'
        && / — (unlocked|locked)/.test(n.props.accessibilityLabel)
        && typeof n.props?.onPress === 'function',
    )
    .filter((n) => {
      const label = n.props.accessibilityLabel as string;
      if (seen.has(label)) return false;
      seen.add(label);
      return true;
    });
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
  mockReduceMotion = false;
  mockApiGet.mockReset();
  // The static catalogue has 12 achievements; an empty progress payload keeps
  // them all locked without touching the load-error path.
  mockApiGet.mockResolvedValue({ data: { achievements: [] } });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('AchievementsScreen', () => {
  it('renders the full badge grid while parked', async () => {
    const root = await renderScreen();

    expect(badgeCards(root)).toHaveLength(12);
    expect(hasText(root, 'Pull over to see 8 more')).toBe(false);
  });

  it('caps the grid to 4 badges with the pull-over notice while in motion (Req 33)', async () => {
    useMotionStore.setState({ isInMotion: true });
    const root = await renderScreen();

    expect(badgeCards(root)).toHaveLength(4);
    expect(hasText(root, 'Pull over to see 8 more')).toBe(true);
  });

  it('renders the unlocked-count badge in fixed ON_ACCENT white on the accent fill', async () => {
    const root = await renderScreen();

    const badgeLabel = root.find((n) => {
      const children = n.props?.children;
      const joined = Array.isArray(children) ? children.join('') : children;
      return joined === '0 / 12 unlocked';
    });
    expect(StyleSheet.flatten(badgeLabel.props.style).color).toBe('#FFFFFF');
  });

  it('opens the detail sheet without springs under OS reduce-motion (Req 39–41)', async () => {
    mockReduceMotion = true;
    const spring = jest.spyOn(Animated, 'spring');
    const root = await renderScreen();

    act(() => { badgeCards(root)[0].props.onPress(); });

    expect(spring).not.toHaveBeenCalled();
    // The sheet still opened — its Close button only exists in the modal.
    expect(hasText(root, 'Close')).toBe(true);
  });

  it('opens the detail sheet with the slide-up spring by default', async () => {
    const spring = jest.spyOn(Animated, 'spring');
    const root = await renderScreen();

    act(() => { badgeCards(root)[0].props.onPress(); });

    expect(spring).toHaveBeenCalled();
  });
});
