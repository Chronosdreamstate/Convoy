/**
 * ConvoyScreen — live admin handover.
 *
 * The API broadcasts `group:admin_transferred` to the group room, and nothing
 * on this side listened: the handover was invisible until something refetched
 * the group, so the new Admin saw none of their controls and the outgoing one
 * kept being offered actions the API now refuses.
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaView: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

jest.mock('expo-router', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => ({}),
    useFocusEffect: (cb: () => void | (() => void)) => R.useEffect(cb, []),
    router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  };
});

// SOSButton (rendered inside an active convoy) calls useIsFocused, which needs
// a real NavigationContainer.
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn().mockResolvedValue(false), shareAsync: jest.fn() }));

const mockApiGet = jest.fn();
const mockApiPost = jest.fn();
jest.mock('../services/apiClient', () => ({
  apiClient: {
    get: (...a: unknown[]) => mockApiGet(...a),
    post: (...a: unknown[]) => mockApiPost(...a),
    patch: jest.fn(async () => ({ data: {} })),
    delete: jest.fn(async () => ({ data: {} })),
  },
}));

import ConvoyScreen from './ConvoyScreen';
import { useGroupStore } from '../stores/groupStore';
import { useSocketStore } from '../stores/socketStore';

const ME = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const GROUP = 'g-1';

type Handler = (payload?: unknown) => void;
const handlers = new Map<string, Handler[]>();

const socketStub = {
  on: (event: string, fn: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), fn]); },
  off: (event: string, fn?: Handler) => {
    if (!fn) { handlers.delete(event); return; }
    handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== fn));
  },
  emit: jest.fn(),
  connected: true,
};

function group(adminId: string) {
  return {
    id: GROUP,
    name: 'Canyon Run',
    code: 'ABC123',
    adminId,
    status: 'active',
    memberCount: 2,
    gapThresholdM: 500,
    pttMaxSeconds: 30,
    isPublic: false,
  };
}

function members(adminId: string) {
  return {
    members: [
      { userId: ME, displayName: 'Alex', isMuted: false, pttCallsign: null, isAdmin: adminId === ME },
      { userId: OTHER, displayName: 'Sam', isMuted: false, pttCallsign: null, isAdmin: adminId === OTHER },
    ],
  };
}

function serve(adminId: string) {
  mockApiGet.mockImplementation(async (url: string) => {
    if (url === `/api/v1/groups/${GROUP}`) return { data: group(adminId) };
    if (url.endsWith('/members')) return { data: members(adminId) };
    if (url.endsWith('/channels')) return { data: { channels: [] } };
    if (url.endsWith('/events')) return { data: { events: [] } };
    return { data: {} };
  });
}

async function fire(event: string, payload: unknown): Promise<void> {
  const fns = handlers.get(event) ?? [];
  if (fns.length === 0) throw new Error(`ConvoyScreen registered no handler for "${event}"`);
  await act(async () => { fns.forEach((fn) => fn(payload)); });
}

async function mountScreen(): Promise<ReactTestInstance> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<ConvoyScreen userId={ME} />); });
  await act(async () => {});
  return renderer.root;
}

function hasLabel(root: ReactTestInstance, label: string): boolean {
  return root.findAll((n) => n.props?.accessibilityLabel === label).length > 0;
}

function hasTextContaining(root: ReactTestInstance, fragment: string): boolean {
  return root
    .findAll((n) => n.props?.children !== undefined)
    .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children)))
    .some((t) => t.includes(fragment));
}

beforeEach(() => {
  handlers.clear();
  mockApiGet.mockReset();
  mockApiPost.mockReset();
  mockApiPost.mockResolvedValue({ data: {} });
  // The screen only restores its group when the store already knows one —
  // without this it renders the no-convoy view and nothing below is exercised.
  useGroupStore.setState({ activeGroupId: GROUP } as never);
  useSocketStore.setState({ socket: socketStub } as never);
});

describe('ConvoyScreen admin handover', () => {
  it('gives the new admin their controls without a refetch', async () => {
    serve(OTHER); // Sam is admin, I am not
    const root = await mountScreen();
    expect(hasLabel(root, 'Schedule a convoy event')).toBe(false);

    await fire('group:admin_transferred', { groupId: GROUP, previousAdminId: OTHER, newAdminId: ME });

    expect(hasLabel(root, 'Schedule a convoy event')).toBe(true);
    expect(hasTextContaining(root, 'You are now the convoy admin')).toBe(true);
    expect(useGroupStore.getState().adminId).toBe(ME);
  });

  it('takes the controls away from the outgoing admin', async () => {
    serve(ME);
    const root = await mountScreen();
    expect(hasLabel(root, 'Schedule a convoy event')).toBe(true);

    await fire('group:admin_transferred', { groupId: GROUP, previousAdminId: ME, newAdminId: OTHER });

    // Buttons the API would now answer with 403 must stop being offered.
    expect(hasLabel(root, 'Schedule a convoy event')).toBe(false);
    expect(hasTextContaining(root, 'Sam is now the convoy admin')).toBe(true);
    expect(useGroupStore.getState().adminId).toBe(OTHER);
  });

  it('re-reads the events card when the server says an event changed', async () => {
    // Fetched once on load, and every change to it is broadcast — so without
    // this a cancelled event kept counting down and RSVP totals stayed frozen.
    serve(OTHER);
    await mountScreen();
    mockApiGet.mockClear();

    await fire('event:rsvp_updated', { groupId: GROUP, eventId: 'e-1' });

    expect(mockApiGet.mock.calls.map((c) => c[0])).toContain(`/api/v1/groups/${GROUP}/events`);
  });

  it('ignores a handover broadcast for a different group', async () => {
    serve(OTHER);
    const root = await mountScreen();

    await fire('group:admin_transferred', { groupId: 'some-other-group', newAdminId: ME });

    expect(hasLabel(root, 'Schedule a convoy event')).toBe(false);
    expect(useGroupStore.getState().adminId).toBe(OTHER);
  });
});
