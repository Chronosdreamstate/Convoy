/**
 * ConvoyLobbyScreen — the lobby's two actions must not fail silently.
 *
 * Both "I'm Ready" and "Start Convoy" are socket emits, and both bailed with a
 * bare `if (!socket) return`: with no live connection the button did nothing at
 * all — no state change, no message — and the member/leader had no way to tell
 * a tap that reached the convoy from one that vanished.
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Alert } from 'react-native';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

jest.mock('../services/apiClient', () => ({
  apiClient: {
    get: jest.fn(async () => ({ data: { members: [] } })),
    post: jest.fn(async () => ({ data: {} })),
  },
}));

jest.mock('../services/AuthService', () => ({
  authService: { refreshToken: jest.fn(async () => null) },
}));

// The lobby stands up its own socket on mount. Returning null models the
// "connection never came up" case the guards exist for; the store keeps
// whatever was there (nothing).
jest.mock('../services/WebSocketService', () => ({
  WebSocketService: class {
    connect() { return null; }
    disconnect = jest.fn();
  },
}));

import ConvoyLobbyScreen from './ConvoyLobbyScreen';
import { useAuthStore } from '../stores/authStore';
import { useGroupStore } from '../stores/groupStore';
import { useSocketStore } from '../stores/socketStore';

const ME = '11111111-1111-1111-1111-111111111111';
const LEADER = '22222222-2222-2222-2222-222222222222';

function pressable(root: ReactTestInstance, label: string): ReactTestInstance {
  const node = root.findAll(
    (n) => n.props?.accessibilityLabel === label && typeof n.props?.onPress === 'function',
  )[0];
  expect(node).toBeDefined();
  return node;
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

async function mountLobby(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ConvoyLobbyScreen groupId="g-1" groupName="Canyon Run" />);
  });
  await act(async () => {});
  return renderer;
}

let alertSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  useAuthStore.setState({
    user: { id: ME, displayName: 'Alex' } as never,
    token: 'tok',
    accessToken: 'tok',
    isAuthenticated: true,
  } as never);
  useSocketStore.setState({ socket: null } as never);
});

afterEach(() => {
  alertSpy.mockRestore();
  useSocketStore.setState({ socket: null } as never);
});

describe('ConvoyLobbyScreen without a live socket', () => {
  it('tells the member their ready-up did not reach the leader instead of latching silently', async () => {
    useGroupStore.setState({ adminId: LEADER } as never);
    const renderer = await mountLobby();

    const ready = pressable(renderer.root, 'Mark yourself as ready');
    await act(async () => { ready.props.onPress(); });

    expect(alertSpy).toHaveBeenCalledWith('Not Connected', expect.stringContaining("wasn't told you're ready"));
    // The one-way "ready" latch must NOT have flipped — showing a tick for a
    // ready-up nobody received is the lie this guard exists to prevent.
    expect(pressable(renderer.root, 'Mark yourself as ready')).toBeDefined();

    renderer.unmount();
  });

  it('shows the leader why Start Convoy did nothing', async () => {
    useGroupStore.setState({ adminId: ME } as never);
    const renderer = await mountLobby();

    const start = pressable(renderer.root, 'Start convoy');
    await act(async () => { start.props.onPress(); });

    expect(renderedText(renderer)).toContain("Couldn't start the convoy");
    // …and the button stays tappable rather than sitting on "Starting…".
    expect(pressable(renderer.root, 'Start convoy')).toBeDefined();

    renderer.unmount();
  });
});
