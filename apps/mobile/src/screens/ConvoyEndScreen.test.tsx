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

import ConvoyEndScreen, { getWeekKey, pruneOldWeeklyDrives } from './ConvoyEndScreen';

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

  it('takes the confetti burst with it when the user leaves mid-celebration', async () => {
    // "Done" is one tap away on this screen and the burst runs for ~3s, so
    // leaving early is the normal case, not the edge one — the animation has to
    // stop rather than keep driving values on an unmounted tree.
    const stagger = jest.spyOn(Animated, 'stagger');
    const renderer = await mountScreen();

    const burst = stagger.mock.results[0].value as Animated.CompositeAnimation;
    const stop = jest.spyOn(burst, 'stop');

    await act(async () => { renderer.unmount(); });

    expect(stop).toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// Weekly drive counter bucket
// ---------------------------------------------------------------------------

describe('getWeekKey', () => {
  afterEach(() => { jest.useRealTimers(); });

  it('gives every day of one Mon-Sun week the same bucket', () => {
    // The "🔥 N-drive week!" banner is bucketed by this key. The old
    // day-of-year arithmetic rolled the week over part-way through SATURDAY,
    // so the weekend fell into a different bucket from the Mon-Fri drives that
    // preceded it: a rider who ended their third convoy of the week on Friday
    // night saw the banner, then ended another on Saturday and saw nothing —
    // while Drive History's Mon-Sun "this week" card still counted all four.
    jest.useFakeTimers();
    // 2026-09-07 is a Monday; noon each day avoids any DST edge.
    const keys = [7, 8, 9, 10, 11, 12, 13].map((day) => {
      jest.setSystemTime(new Date(2026, 8, day, 12, 0));
      return getWeekKey();
    });

    expect(new Set(keys).size).toBe(1);
  });

  it('keeps Sunday night and Monday morning in different weeks', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 8, 13, 23, 30)); // Sunday
    const sunday = getWeekKey();

    jest.setSystemTime(new Date(2026, 8, 14, 0, 30)); // Monday — new week
    const monday = getWeekKey();

    expect(monday).not.toBe(sunday);
  });

  it('keys on the Monday that starts the local week', () => {
    jest.useFakeTimers();
    // Wednesday 2026-09-09 → Monday 2026-09-07.
    jest.setSystemTime(new Date(2026, 8, 9, 14, 0));
    expect(getWeekKey()).toBe('2026-09-07');

    // Sunday 2026-09-13 still belongs to the week that began Monday the 7th.
    jest.setSystemTime(new Date(2026, 8, 13, 14, 0));
    expect(getWeekKey()).toBe('2026-09-07');
  });
});

// ---------------------------------------------------------------------------
// Weekly counter housekeeping. Only the current week's bucket is ever read, so
// every other one is dead weight in AsyncStorage — and ending a convoy is the
// only moment anything touches that key space.
// ---------------------------------------------------------------------------

const WEEK_PREFIX = 'convoy_weekly_drives_';

async function weeklyKeys(): Promise<string[]> {
  const keys = await AsyncStorage.getAllKeys();
  return keys.filter((k) => k.startsWith(WEEK_PREFIX)).sort();
}

describe('weekly drive counters', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    // Wednesday of the week that starts Monday 2026-09-07.
    jest.setSystemTime(new Date(2026, 8, 9, 12, 0));
  });

  it('drops counters left behind by weeks that have already ended', async () => {
    // Two months of driving used to leave two months of keys: one row per week,
    // forever, with nothing that ever read or removed them.
    await AsyncStorage.setItem(`${WEEK_PREFIX}2026-08-24`, '5');
    await AsyncStorage.setItem(`${WEEK_PREFIX}2026-08-31`, '2');

    await mountScreen();

    expect(await weeklyKeys()).toEqual([`${WEEK_PREFIX}2026-09-07`]);
    expect(await AsyncStorage.getItem(`${WEEK_PREFIX}2026-09-07`)).toBe('1');
  });

  it('keeps counting this week rather than restarting it', async () => {
    await AsyncStorage.setItem(`${WEEK_PREFIX}2026-09-07`, '2');
    await AsyncStorage.setItem(`${WEEK_PREFIX}2026-08-31`, '9');

    const renderer = await mountScreen();

    expect(await AsyncStorage.getItem(`${WEEK_PREFIX}2026-09-07`)).toBe('3');
    expect(await weeklyKeys()).toEqual([`${WEEK_PREFIX}2026-09-07`]);
    // Third drive of the week — the streak banner is showing.
    expect(hasText(renderer.root, "🔥 3-drive week! You're on a streak!")).toBe(true);
  });

  it('leaves untouched anything it does not own', async () => {
    await AsyncStorage.setItem('convoy:completed_count', '4');
    await AsyncStorage.setItem(`${WEEK_PREFIX}2026-08-31`, '9');

    await mountScreen();

    expect(await AsyncStorage.getItem('convoy:completed_count')).toBe('5');
  });

  it('leaves a future-dated bucket alone (a clock that jumped and came back)', async () => {
    await AsyncStorage.setItem(`${WEEK_PREFIX}2026-09-14`, '1');
    await AsyncStorage.setItem(`${WEEK_PREFIX}2026-08-31`, '9');

    await pruneOldWeeklyDrives('2026-09-07');

    expect(await weeklyKeys()).toEqual([`${WEEK_PREFIX}2026-09-14`]);
  });
});
