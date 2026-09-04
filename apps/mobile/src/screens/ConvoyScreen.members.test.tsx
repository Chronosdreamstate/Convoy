/**
 * ConvoyScreen — the member roster must not lie when its fetch fails.
 *
 * GET /groups/:id/members failing used to be swallowed ("silently fail – user
 * will see empty list"), so the primary convoy screen rendered "MEMBERS (0)"
 * and "Waiting for members to join…" — indistinguishable from a genuinely
 * empty convoy, on the one screen the driver trusts to tell them who is with
 * them. A failed fetch now offers a retry instead, and a transient failure
 * while a roster is already loaded must not blank it.
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
jest.mock('../services/apiClient', () => ({
  apiClient: {
    get: (...a: unknown[]) => mockApiGet(...a),
    post: jest.fn(async () => ({ data: {} })),
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

async function fire(event: string, payload: unknown): Promise<void> {
  const fns = handlers.get(event) ?? [];
  if (fns.length === 0) throw new Error(`ConvoyScreen registered no handler for "${event}"`);
  await act(async () => { fns.forEach((fn) => fn(payload)); });
  await act(async () => {});
}

const GROUP_PAYLOAD = {
  id: GROUP,
  name: 'Canyon Run',
  code: 'ABC123',
  adminId: OTHER,
  status: 'active',
  memberCount: 2,
  gapThresholdM: 500,
  pttMaxSeconds: 30,
  isPublic: false,
};

const MEMBERS_PAYLOAD = {
  members: [
    { userId: ME, displayName: 'Alex', isMuted: false, pttCallsign: null, isAdmin: false },
    { userId: OTHER, displayName: 'Sam', isMuted: false, pttCallsign: null, isAdmin: true },
  ],
};

/** `membersResult` decides what GET …/members does on each call. */
function serve(membersResult: () => Promise<unknown>) {
  mockApiGet.mockImplementation(async (url: string) => {
    if (url === `/api/v1/groups/${GROUP}`) return { data: GROUP_PAYLOAD };
    if (url.endsWith('/members')) return membersResult();
    if (url.endsWith('/channels')) return { data: { channels: [] } };
    if (url.endsWith('/events')) return { data: { events: [] } };
    return { data: {} };
  });
}

async function mountScreen(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<ConvoyScreen userId={ME} />); });
  await act(async () => {});
  return renderer;
}

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    walk((node as { children?: unknown }).children);
  };
  walk(renderer.toJSON());
  return out.join(' ');
}

/** Pressables carrying this label, deduped (composite + host both match). */
function pressablesWithLabel(root: ReactTestInstance, label: string): ReactTestInstance[] {
  return root.findAll(
    (n) => n.props?.accessibilityLabel === label && typeof n.props?.onPress === 'function',
  );
}

beforeEach(() => {
  handlers.clear();
  mockApiGet.mockReset();
  useGroupStore.setState({ activeGroupId: GROUP } as never);
  useSocketStore.setState({ socket: socketStub } as never);
});

describe('ConvoyScreen member roster failure path', () => {
  it('offers a retry instead of "Waiting for members to join…" when the fetch fails', async () => {
    serve(() => Promise.reject(new Error('offline')));
    const renderer = await mountScreen();

    const text = renderedText(renderer);
    expect(text).toContain("Couldn't load members — tap to retry");
    // The empty-convoy copy is a lie here — the user IS in a convoy.
    expect(text).not.toContain('Waiting for members to join…');

    renderer.unmount();
  });

  it('recovers the roster when the retry succeeds', async () => {
    let fail = true;
    serve(() => (fail ? Promise.reject(new Error('offline')) : Promise.resolve({ data: MEMBERS_PAYLOAD })));
    const renderer = await mountScreen();
    expect(renderedText(renderer)).toContain("Couldn't load members — tap to retry");

    fail = false;
    const [retry] = pressablesWithLabel(renderer.root, 'Retry loading members');
    expect(retry).toBeDefined();
    await act(async () => { retry.props.onPress(); });
    await act(async () => {});

    const text = renderedText(renderer);
    expect(text).toContain('Sam');
    expect(text).not.toContain("Couldn't load members — tap to retry");

    renderer.unmount();
  });

  it('keeps an already-loaded roster on screen when a later refresh fails', async () => {
    let fail = false;
    serve(() => (fail ? Promise.reject(new Error('offline')) : Promise.resolve({ data: MEMBERS_PAYLOAD })));
    const renderer = await mountScreen();
    expect(renderedText(renderer)).toContain('Sam');

    // `member:joined` triggers a refetch. When that refetch fails, the roster
    // already on screen must survive — the retry affordance only stands in for
    // an EMPTY list.
    fail = true;
    await fire('member:joined', { userId: 'someone-new' });

    const text = renderedText(renderer);
    expect(text).toContain('Sam');
    expect(text).not.toContain("Couldn't load members — tap to retry");

    renderer.unmount();
  });
});
