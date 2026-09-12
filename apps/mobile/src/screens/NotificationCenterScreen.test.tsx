/**
 * Unit tests for NotificationCenterScreen.
 *
 * Req 33 (in-motion list cap) + the notification user stories:
 *  - While the vehicle is in motion the list caps to 4 rows with the shared
 *    "pull over" notice, and restores in full the moment the car parks —
 *    notifications are plausibly checked mid-drive.
 *  - Deep links must land somewhere valid: event notifications carry
 *    { groupId, eventId } (see groups.routes.ts pushes) and should open the
 *    event detail screen directly so the rider can RSVP in one tap; older
 *    payloads without an eventId still fall back to the group screen.
 *  - Read-state honesty: tapping a row marks it read locally AND tells the
 *    server; the header unread badge tracks the real unread count.
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';
import { AppState, Text } from 'react-native';
import { useMotionStore } from '../stores/motionStore';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockApiGet = jest.fn();
const mockApiPatch = jest.fn();
jest.mock('../services/apiClient', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockApiGet(...args),
    patch: (...args: unknown[]) => mockApiPatch(...args),
  },
}));

const mockRouterPush = jest.fn();
const mockRouterBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockRouterPush, back: mockRouterBack, replace: jest.fn() }),
}));

let mockReduceMotion = false;
jest.mock('../hooks/useReduceMotion', () => ({
  useReduceMotion: () => mockReduceMotion,
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import NotificationCenterScreen, { NotificationItem, useTickingNow } from './NotificationCenterScreen';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface NotificationFixture {
  id: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  createdAt: string;
  readAt: string | null;
}

function notification(overrides: Partial<NotificationFixture> & { id: string; title: string }): NotificationFixture {
  return {
    type: 'convoy_started',
    body: 'Something happened',
    createdAt: new Date().toISOString(),
    readAt: null,
    ...overrides,
  };
}

async function renderScreen(notifications: NotificationFixture[]): Promise<TestRenderer.ReactTestRenderer> {
  mockApiGet.mockResolvedValue({ data: { notifications } });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<NotificationCenterScreen />);
  });
  // Flush the cache read + GET /notifications load.
  await act(async () => {});
  return renderer;
}

/**
 * Distinct rendered notification rows. Composite touchables render their
 * props on both the component node and its host view, so nodes are deduped
 * by label — pressing the first node still drives the row's onPress.
 */
function rows(root: ReactTestInstance): ReactTestInstance[] {
  const seen = new Set<string>();
  return root
    .findAll(
      (n) => typeof n.props?.accessibilityLabel === 'string'
        && n.props.accessibilityLabel.startsWith('Notif ')
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
    if (children === undefined || children === null) return false;
    const joined = Array.isArray(children) ? children.join('') : String(children);
    return joined === text;
  }).length > 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(async () => {
  useMotionStore.setState({ isInMotion: false });
  mockReduceMotion = false;
  mockApiGet.mockReset();
  mockApiPatch.mockReset();
  mockApiPatch.mockResolvedValue({ data: { ok: true } });
  mockRouterPush.mockReset();
  await AsyncStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('NotificationCenterScreen — Req 33 in-motion cap', () => {
  const SIX = [1, 2, 3, 4, 5, 6].map((i) => notification({ id: `n-${i}`, title: `Notif ${i}` }));

  it('renders the full list while parked', async () => {
    const renderer = await renderScreen(SIX);
    expect(rows(renderer.root)).toHaveLength(6);
    expect(hasText(renderer.root, 'Pull over to see 2 more')).toBe(false);
  });

  it('caps to 4 rows with the pull-over notice while in motion, and restores on park', async () => {
    const renderer = await renderScreen(SIX);

    await act(async () => { useMotionStore.setState({ isInMotion: true }); });
    expect(rows(renderer.root)).toHaveLength(4);
    expect(hasText(renderer.root, 'Pull over to see 2 more')).toBe(true);

    await act(async () => { useMotionStore.setState({ isInMotion: false }); });
    expect(rows(renderer.root)).toHaveLength(6);
    expect(hasText(renderer.root, 'Pull over to see 2 more')).toBe(false);
  });
});

describe('NotificationCenterScreen — deep links', () => {
  it('an event notification with an eventId lands on the event detail screen', async () => {
    const renderer = await renderScreen([
      notification({
        id: 'n-1',
        title: 'Notif reminder',
        type: 'event_reminder',
        data: { groupId: 'g-1', eventId: 'e-1' },
      }),
    ]);

    const row = renderer.root.findAll(
      (n) => n.props?.accessibilityLabel === 'Notif reminder' && typeof n.props?.onPress === 'function',
    )[0];
    await act(async () => { row.props.onPress(); });

    expect(mockRouterPush).toHaveBeenCalledWith({
      pathname: '/event/[id]',
      params: { id: 'e-1', groupId: 'g-1' },
    });
    // Tapping also reports the read to the server.
    expect(mockApiPatch).toHaveBeenCalledWith('/api/v1/notifications/n-1/read');
  });

  it('an event notification without an eventId falls back to the group screen', async () => {
    const renderer = await renderScreen([
      notification({
        id: 'n-2',
        title: 'Notif event',
        type: 'group_event',
        data: { groupId: 'g-9' },
      }),
    ]);

    const row = renderer.root.findAll(
      (n) => n.props?.accessibilityLabel === 'Notif event' && typeof n.props?.onPress === 'function',
    )[0];
    await act(async () => { row.props.onPress(); });

    expect(mockRouterPush).toHaveBeenCalledWith('/group/g-9');
  });
});

// ---------------------------------------------------------------------------
// Relative ages. "3s ago" is a promise that the number means something now —
// a row that arrives while the center is open has to keep counting.
// ---------------------------------------------------------------------------

describe('NotificationCenterScreen — ticking ages', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 8, 12, 14, 0, 0));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps a row\'s age label up to date while the screen sits open', async () => {
    // The age used to be computed once per render against Date.now(), and
    // nothing re-rendered on a clock: an SOS that landed while the center was
    // open said "0s ago" for as long as the user kept looking at it.
    const renderer = await renderScreen([notification({ id: 'n-1', title: 'Notif 1' })]);
    expect(hasText(renderer.root, '0s ago')).toBe(true);

    await act(async () => { jest.advanceTimersByTime(5_000); });
    expect(hasText(renderer.root, '5s ago')).toBe(true);

    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(hasText(renderer.root, '1m ago')).toBe(true);
  });

  it('stops ticking while the app is backgrounded and resyncs on return', async () => {
    let onAppStateChange: ((state: string) => void) | undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, cb) => {
      onAppStateChange = cb as (state: string) => void;
      return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
    });

    const renderer = await renderScreen([notification({ id: 'n-1', title: 'Notif 1' })]);
    await act(async () => { jest.advanceTimersByTime(5_000); });
    expect(hasText(renderer.root, '5s ago')).toBe(true);

    // Backgrounded: repainting a list nobody can see is pure battery.
    await act(async () => { onAppStateChange?.('background'); });
    await act(async () => { jest.advanceTimersByTime(120_000); });
    expect(hasText(renderer.root, '5s ago')).toBe(true);

    // ...but the first frame the user sees again is current, not two minutes stale.
    await act(async () => { onAppStateChange?.('active'); });
    expect(hasText(renderer.root, '2m ago')).toBe(true);
  });
});

describe('useTickingNow', () => {
  function Harness({ items }: { items: NotificationItem[] }) {
    return <Text>{String(useTickingNow(items))}</Text>;
  }

  /**
   * Ids of the timers the clock scheduled for itself. React and RN schedule
   * timers of their own in this environment, so they're picked out by the two
   * cadences tickDelayMs can return rather than by counting pending timers.
   */
  const TICK_DELAYS = [1_000, 60_000];
  function tickTimerIds(setSpy: jest.SpyInstance): unknown[] {
    return setSpy.mock.calls
      .map((call, i) => (TICK_DELAYS.includes(call[1] as number) ? setSpy.mock.results[i].value : undefined))
      .filter((id) => id !== undefined);
  }

  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('takes its timer with it when the screen goes away', async () => {
    const setSpy = jest.spyOn(global, 'setTimeout');
    const clearSpy = jest.spyOn(global, 'clearTimeout');

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <Harness items={[notification({ id: 'n-1', title: 'Notif 1' }) as NotificationItem]} />,
      );
    });
    const scheduled = tickTimerIds(setSpy);
    expect(scheduled).toHaveLength(1);

    await act(async () => { renderer.unmount(); });
    expect(clearSpy).toHaveBeenCalledWith(scheduled[0]);
  });

  it('schedules nothing at all for an empty list', async () => {
    const setSpy = jest.spyOn(global, 'setTimeout');
    await act(async () => { TestRenderer.create(<Harness items={[]} />); });

    expect(tickTimerIds(setSpy)).toEqual([]);
  });
});

describe('NotificationCenterScreen — read-state honesty', () => {
  it('unread badge tracks taps, and mark-all-read clears it via the server', async () => {
    const renderer = await renderScreen([
      notification({ id: 'n-1', title: 'Notif 1' }),
      notification({ id: 'n-2', title: 'Notif 2' }),
    ]);

    expect(hasText(renderer.root, '2')).toBe(true);

    const row = renderer.root.findAll(
      (n) => n.props?.accessibilityLabel === 'Notif 1' && typeof n.props?.onPress === 'function',
    )[0];
    await act(async () => { row.props.onPress(); });
    expect(hasText(renderer.root, '1')).toBe(true);

    const markAll = renderer.root.findAll(
      (n) => n.props?.accessibilityLabel === 'Mark all notifications as read' && typeof n.props?.onPress === 'function',
    )[0];
    await act(async () => { markAll.props.onPress(); });

    expect(mockApiPatch).toHaveBeenCalledWith('/api/v1/notifications/read-all');
    // Badge (and the mark-all affordance) are gone once nothing is unread.
    expect(renderer.root.findAll(
      (n) => n.props?.accessibilityLabel === 'Mark all notifications as read',
    )).toHaveLength(0);
  });
});
