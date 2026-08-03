/**
 * Unit tests for ConvoyEndScreen.
 *
 * Req 19.4–19.6 (end-of-drive summary) + Req 39–41 (reduce motion):
 *  - The summary must reflect what the drive actually recorded — and when a
 *    drive failed to save (missing/malformed navigation params), it must
 *    render honest zeros, never "NaN m" / "NaNm".
 *  - Under OS reduce-motion the celebration gets a static equivalent: no
 *    confetti burst, no trophy spring.
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Alert, Animated } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  launchImageLibraryAsync: jest.fn(),
  MediaTypeOptions: { Images: 'Images' },
}));

jest.mock('expo-media-library', () => ({
  requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  saveToLibraryAsync: jest.fn(),
}));

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(false),
  shareAsync: jest.fn(),
}));

jest.mock('react-native-view-shot', () => ({
  captureRef: jest.fn().mockResolvedValue('file://card.png'),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

let mockParams: Record<string, string | undefined> = {};
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
}));

let mockReduceMotion = false;
jest.mock('../hooks/useReduceMotion', () => ({
  useReduceMotion: () => mockReduceMotion,
}));

import ConvoyEndScreen from './ConvoyEndScreen';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function renderScreen(): Promise<ReactTestInstance> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ConvoyEndScreen />);
  });
  return renderer.root;
}

/** Renders and hands back the renderer so a test can unmount mid-flight. */
async function mountScreen(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ConvoyEndScreen />);
  });
  // Both delayed prompts are scheduled from async effects — let those settle.
  await act(async () => {});
  return renderer;
}

async function advance(ms: number): Promise<void> {
  await act(async () => { jest.advanceTimersByTime(ms); });
  await act(async () => {});
}

/** Every rendered Text string (flattened) in the tree. */
function allTexts(root: ReactTestInstance): string[] {
  return root
    .findAll((n) => n.props?.children !== undefined)
    .map((n) => {
      const children = n.props.children;
      return Array.isArray(children) ? children.join('') : String(children);
    });
}

/** True if any Text node's flattened children join to exactly this string. */
function hasText(root: ReactTestInstance, text: string): boolean {
  return allTexts(root).includes(text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.useFakeTimers();
  mockReduceMotion = false;
  mockParams = {
    groupName: 'Canyon Crew',
    durationMinutes: '45',
    distanceM: '32000',
    memberCount: '4',
    topSpeedKmh: '112',
  };
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('ConvoyEndScreen', () => {
  it('shows the stats the drive actually recorded', async () => {
    const root = await renderScreen();

    expect(hasText(root, '45m')).toBe(true);      // duration
    expect(hasText(root, '32.0 km')).toBe(true);  // distance
    expect(hasText(root, '4')).toBe(true);        // members
  });

  it('renders honest zeros — never NaN — when a drive failed to save its params', async () => {
    mockParams = {
      groupName: undefined,
      durationMinutes: 'garbage',
      distanceM: undefined,
      memberCount: 'NaN',
      topSpeedKmh: 'abc',
    };
    const root = await renderScreen();

    for (const text of allTexts(root)) {
      expect(text).not.toMatch(/NaN/);
    }
    expect(hasText(root, '0m')).toBe(true);   // zero duration
    expect(hasText(root, '0 m')).toBe(true);  // zero distance
    // Member count floor is 1 (you were on the drive).
    expect(hasText(root, '1')).toBe(true);
  });

  it('skips the confetti burst and trophy spring under OS reduce-motion (Req 39–41)', async () => {
    mockReduceMotion = true;
    const spring = jest.spyOn(Animated, 'spring');
    const stagger = jest.spyOn(Animated, 'stagger');

    const root = await renderScreen();

    expect(stagger).not.toHaveBeenCalled(); // no confetti
    expect(spring).not.toHaveBeenCalled();  // no trophy pop
    // The celebration content is still fully present.
    expect(hasText(root, 'Convoy Complete')).toBe(true);
  });

  it('plays the confetti burst by default', async () => {
    const stagger = jest.spyOn(Animated, 'stagger');
    await renderScreen();

    expect(stagger).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Delayed prompts. Both are scheduled on a timer, and the summary is a screen
// people leave quickly — so both have to survive being left.
// ---------------------------------------------------------------------------

describe('ConvoyEndScreen delayed prompts', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('does not fire the review prompt after the user has left the screen', async () => {
    await AsyncStorage.setItem('convoy:completed_count', '2'); // this drive is the 3rd
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const renderer = await mountScreen();

    // Tapping Done a second in is entirely normal; the alert used to arrive
    // three seconds later on whatever screen the user had moved to.
    await act(async () => { renderer.unmount(); });
    await advance(5000);

    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('keeps the review ask for next time when the user leaves before it appears', async () => {
    await AsyncStorage.setItem('convoy:completed_count', '2');
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    const first = await mountScreen();
    await act(async () => { first.unmount(); });
    await advance(5000);
    expect(alertSpy).not.toHaveBeenCalled();
    // Nothing recorded — the ask was never made.
    expect(await AsyncStorage.getItem('convoy:review_prompted')).toBeNull();

    // Next convoy: the ask still happens (it used to be gated on the count
    // being exactly 3, so leaving early burned the only chance forever).
    await mountScreen();
    await advance(3000);

    expect(alertSpy).toHaveBeenCalledWith(
      expect.stringContaining('Loving CORTEGE'),
      expect.any(String),
      expect.any(Array),
    );
    expect(await AsyncStorage.getItem('convoy:review_prompted')).toBe('true');
  });

  it('asks only once across later convoys', async () => {
    await AsyncStorage.setItem('convoy:completed_count', '2');
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    await mountScreen();
    await advance(3000);
    expect(alertSpy).toHaveBeenCalledTimes(1);

    await mountScreen();
    await advance(3000);
    expect(alertSpy).toHaveBeenCalledTimes(1);
  });

  it('records the first-convoy unlock only when the card is actually shown', async () => {
    // First convoy ever.
    const renderer = await mountScreen();
    await act(async () => { renderer.unmount(); });
    await advance(3000);

    // Left before the 1.8s reveal — nothing was granted, and nothing animated
    // into an unmounted tree.
    expect(await AsyncStorage.getItem('achievement:first_convoy')).toBeNull();
  });

  it('shows and records the first-convoy unlock when the user stays', async () => {
    const renderer = await mountScreen();
    await advance(2000);

    expect(hasText(renderer.root, 'First Convoy')).toBe(true);
    expect(await AsyncStorage.getItem('achievement:first_convoy')).toBe('true');
  });
});
