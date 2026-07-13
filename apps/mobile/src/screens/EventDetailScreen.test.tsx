/**
 * Unit tests for EventDetailScreen's load states and RSVP flow.
 *
 * Req 7/events user stories:
 *  - A failed fetch shows the network error with a retry that can help; an
 *    event that's genuinely gone (passed or cancelled — the events list only
 *    carries upcoming events) shows an honest "Event unavailable" state with
 *    a way back instead of a retry that can never succeed.
 *  - RSVPing updates the selected pill and live counts from the server
 *    response (state stays consistent with the list's myRsvp).
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/SiriShortcutsService', () => ({
  SiriShortcutsService: { donateAll: jest.fn().mockResolvedValue(undefined) },
}));

const mockApiGet = jest.fn();
const mockApiPost = jest.fn();
jest.mock('../services/apiClient', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
    delete: jest.fn(),
  },
}));

const mockRouterBack = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'e-1', groupId: 'g-1' }),
  // The factory is hoisted above the const above, so defer the reference
  // until the call actually happens.
  router: {
    back: (...args: unknown[]) => mockRouterBack(...args),
    push: () => {},
    replace: () => {},
  },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import EventDetailScreen from './EventDetailScreen';
import { useAuthStore, User } from '../stores/authStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ME: User = { id: 'u-1', displayName: 'Me', privacy: 'open' };

const FUTURE_EVENT = {
  id: 'e-1',
  title: 'Sunday Cruise',
  description: null,
  scheduledFor: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  status: 'upcoming',
  createdBy: 'u-9',
};

const EMPTY_RSVPS = { rsvps: [], counts: { going: 0, maybe: 0, not_going: 0 }, myStatus: null };

function mockLoad(events: unknown[], rsvpPayload: unknown = EMPTY_RSVPS) {
  mockApiGet.mockImplementation((url: string) => {
    if (url === '/api/v1/groups/g-1/events') {
      return Promise.resolve({ data: { events } });
    }
    if (url === '/api/v1/groups/g-1/events/e-1/rsvps') {
      return Promise.resolve({ data: rsvpPayload });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

async function renderScreen(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<EventDetailScreen />);
  });
  await act(async () => {});
  return renderer;
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
  useAuthStore.setState({ user: ME });
  mockApiGet.mockReset();
  mockApiPost.mockReset();
  mockRouterBack.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('EventDetailScreen — load states', () => {
  it('a failed fetch shows the network error with a retry', async () => {
    mockApiGet.mockRejectedValue(new Error('offline'));
    const renderer = await renderScreen();

    expect(hasText(renderer.root, 'Could not load this event. Check your connection.')).toBe(true);
    // Retry genuinely reloads.
    mockLoad([FUTURE_EVENT]);
    const retry = renderer.root.findAll(
      (n) => n.props?.children === 'Try Again' || n.props?.accessibilityLabel === 'Try Again',
    )[0];
    expect(retry).toBeDefined();
  });

  it('an event missing from a successful fetch shows "Event unavailable" with a way back, not a retry', async () => {
    mockLoad([]); // fetch works; the event has passed or was cancelled
    const renderer = await renderScreen();

    expect(hasText(renderer.root, 'Event unavailable')).toBe(true);
    expect(hasText(renderer.root, 'This event has already happened or was cancelled.')).toBe(true);
    expect(hasText(renderer.root, 'No Connection')).toBe(false);

    await act(async () => { byLabel(renderer.root, 'Go back to previous screen').props.onPress(); });
    expect(mockRouterBack).toHaveBeenCalled();
  });
});

describe('EventDetailScreen — RSVP flow', () => {
  it('RSVPing marks the pill selected and applies the server counts', async () => {
    // Stateful mock: handleRsvp applies the POST response and then re-fetches,
    // so the rsvps GET must reflect the upsert like the real server does.
    const rsvpState = { rsvps: [], counts: { going: 0, maybe: 0, not_going: 0 }, myStatus: null as string | null };
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/v1/groups/g-1/events') {
        return Promise.resolve({ data: { events: [FUTURE_EVENT] } });
      }
      if (url === '/api/v1/groups/g-1/events/e-1/rsvps') {
        return Promise.resolve({ data: { ...rsvpState } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    mockApiPost.mockImplementation(() => {
      rsvpState.myStatus = 'maybe';
      rsvpState.counts = { going: 2, maybe: 5, not_going: 1 };
      return Promise.resolve({ data: { rsvp: { status: 'maybe' }, counts: rsvpState.counts } });
    });
    const renderer = await renderScreen();

    await act(async () => { byLabel(renderer.root, 'Maybe').props.onPress(); });

    expect(mockApiPost).toHaveBeenCalledWith(
      '/api/v1/groups/g-1/events/e-1/rsvp',
      { status: 'maybe' },
    );
    const maybePill = renderer.root.findAll(
      (n) => n.props?.accessibilityLabel === 'Maybe' && n.props?.accessibilityState !== undefined,
    )[0];
    expect(maybePill.props.accessibilityState.selected).toBe(true);
    expect(hasText(renderer.root, '5')).toBe(true);
  });
});
