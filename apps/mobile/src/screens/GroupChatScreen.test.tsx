/**
 * Unit tests for GroupChatScreen's DM/group thread isolation and composer
 * behaviour.
 *
 * Requirement 30 (DMs) + the group-chat user stories:
 *  - Cross-thread bleed: this socket sits in the active convoy's room AND
 *    every DM room at once, so a legacy `group:message` / `chat:typing` event
 *    WITHOUT a groupId stamp can only be attributed to the thread on screen
 *    when that thread IS the active convoy. While a DM is open, unstamped
 *    convoy events must be dropped (there is history of exactly this
 *    cross-contamination); stamped events for the DM must land.
 *  - Quick replies send their own text and must NOT wipe a half-typed draft
 *    out of the composer.
 *  - Reduce-motion: the reaction picker appears in place (no spring pop).
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Animated } from 'react-native';

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
const mockApiDelete = jest.fn();
jest.mock('../services/apiClient', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
    delete: (...args: unknown[]) => mockApiDelete(...args),
  },
}));

let mockGroupIdParam = 'dm-1';
const mockRouterBack = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ groupId: mockGroupIdParam }),
  useRouter: () => ({ back: mockRouterBack, push: jest.fn(), replace: jest.fn() }),
}));

jest.mock('expo-av', () => ({
  Audio: {
    requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: false }),
    setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
    Recording: { createAsync: jest.fn() },
    RecordingOptionsPresets: { HIGH_QUALITY: {} },
    Sound: { createAsync: jest.fn() },
  },
}));

jest.mock('expo-file-system/legacy', () => ({
  uploadAsync: jest.fn(),
  FileSystemUploadType: { MULTIPART: 'MULTIPART' },
}));

let mockReduceMotion = false;
jest.mock('../hooks/useReduceMotion', () => ({
  useReduceMotion: () => mockReduceMotion,
}));

import GroupChatScreen from './GroupChatScreen';
import { useAuthStore, User } from '../stores/authStore';
import { useGroupStore } from '../stores/groupStore';
import { useSocketStore } from '../stores/socketStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ME: User = { id: 'u-1', displayName: 'Me', privacy: 'open' };

interface FakeSocket {
  connected: boolean;
  on: jest.Mock;
  off: jest.Mock;
  emit: jest.Mock;
  handlers: Record<string, (payload: unknown) => void>;
}

function makeFakeSocket(): FakeSocket {
  const handlers: Record<string, (payload: unknown) => void> = {};
  return {
    connected: true,
    handlers,
    on: jest.fn((event: string, fn: (payload: unknown) => void) => { handlers[event] = fn; }),
    off: jest.fn(),
    emit: jest.fn(),
  };
}

function message(overrides: Partial<Record<string, unknown>> & { id: string }) {
  return {
    userId: 'u-2',
    displayName: 'Buddy',
    avatarUrl: null,
    text: 'hello',
    createdAt: '2026-07-12T00:00:00.000Z',
    type: 'text',
    ...overrides,
  };
}

function mockChatApi(groupId: string, type: 'group' | 'dm', initialMessages: unknown[]) {
  mockApiGet.mockImplementation((url: string) => {
    if (url.startsWith(`/api/v1/groups/${groupId}/messages`)) {
      return Promise.resolve({ data: { messages: initialMessages, nextCursor: null } });
    }
    if (url === `/api/v1/groups/${groupId}/members`) {
      return Promise.resolve({
        data: {
          members: [
            { userId: 'u-1', displayName: 'Me', avatarUrl: null },
            { userId: 'u-2', displayName: 'Buddy', avatarUrl: null },
          ],
        },
      });
    }
    if (url === `/api/v1/groups/${groupId}`) {
      return Promise.resolve({ data: { type } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

async function renderChat(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<GroupChatScreen />);
  });
  // Flush the initial messages + group-info loads.
  await act(async () => {});
  return renderer;
}

/** All raw strings rendered anywhere in the tree, joined for containment checks. */
function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const el = node as { children?: unknown };
    walk(el.children);
  };
  walk(renderer.toJSON());
  return out.join('\n');
}

function findByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const node = root.findAll((n) => n.props?.accessibilityLabel === label)[0];
  expect(node).toBeDefined();
  return node;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GroupChatScreen — DM/group thread isolation', () => {
  let socket: FakeSocket;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReduceMotion = false;
    socket = makeFakeSocket();
    useAuthStore.setState({ user: ME, accessToken: 'tok', token: 'tok', isAuthenticated: true });
    useGroupStore.setState({ activeGroupId: 'convoy-9' });
    useSocketStore.setState({ socket: socket as never, isConnected: true });
  });

  afterEach(() => {
    useSocketStore.setState({ socket: null, isConnected: false });
    useGroupStore.setState({ activeGroupId: null });
  });

  it('drops unstamped legacy events while a DM is open, but accepts events stamped for the DM', async () => {
    mockGroupIdParam = 'dm-1';
    mockChatApi('dm-1', 'dm', [message({ id: 'm-1', text: 'existing dm message' })]);
    const renderer = await renderChat();

    // Unstamped legacy event — attributable only to the active convoy
    // (convoy-9), NOT this DM. Must not appear in the transcript.
    await act(async () => {
      socket.handlers['group:message'](message({ id: 'm-legacy', text: 'convoy chatter' }));
    });
    expect(renderedText(renderer)).not.toContain('convoy chatter');

    // Stamped for this DM — must appear.
    await act(async () => {
      socket.handlers['group:message'](message({ id: 'm-dm', groupId: 'dm-1', text: 'stamped dm hello' }));
    });
    expect(renderedText(renderer)).toContain('stamped dm hello');

    // Same rule for typing: unstamped is dropped, stamped shows the indicator.
    await act(async () => {
      socket.handlers['chat:typing']({ userId: 'u-2', displayName: 'Buddy' });
    });
    expect(renderedText(renderer)).not.toContain('is typing');
    await act(async () => {
      socket.handlers['chat:typing']({ userId: 'u-2', displayName: 'Buddy', groupId: 'dm-1' });
    });
    // ("Buddy" and " is typing…" are separate text children of the same node.)
    expect(renderedText(renderer)).toContain(' is typing…');

    renderer.unmount();
  });

  it('still accepts unstamped legacy events when the on-screen thread IS the active convoy', async () => {
    mockGroupIdParam = 'convoy-9';
    mockChatApi('convoy-9', 'group', []);
    const renderer = await renderChat();

    await act(async () => {
      socket.handlers['group:message'](message({ id: 'm-legacy', text: 'legacy convoy message' }));
    });
    expect(renderedText(renderer)).toContain('legacy convoy message');

    renderer.unmount();
  });
});

describe('GroupChatScreen — composer', () => {
  let socket: FakeSocket;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReduceMotion = false;
    socket = makeFakeSocket();
    useAuthStore.setState({ user: ME, accessToken: 'tok', token: 'tok', isAuthenticated: true });
    useGroupStore.setState({ activeGroupId: 'convoy-9' });
    useSocketStore.setState({ socket: socket as never, isConnected: true });
    mockGroupIdParam = 'dm-1';
    mockChatApi('dm-1', 'dm', []);
  });

  afterEach(() => {
    useSocketStore.setState({ socket: null, isConnected: false });
    useGroupStore.setState({ activeGroupId: null });
  });

  it('a quick reply sends its own text without wiping the typed draft', async () => {
    mockApiPost.mockResolvedValue({ data: message({ id: 'm-server', userId: 'u-1', text: '👍 Got it' }) });
    const renderer = await renderChat();

    // Half-typed draft in the composer…
    await act(async () => {
      findByLabel(renderer.root, 'Message input').props.onChangeText('my half-typed draft');
    });
    // …then a quick reply is tapped.
    await act(async () => {
      findByLabel(renderer.root, '👍 Got it').props.onPress();
    });

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/groups/dm-1/messages', { text: '👍 Got it' });
    // The draft survives — quick replies must not clear the input box.
    expect(findByLabel(renderer.root, 'Message input').props.value).toBe('my half-typed draft');

    renderer.unmount();
  });

  it('sending from the composer clears the input', async () => {
    mockApiPost.mockResolvedValue({ data: message({ id: 'm-server', userId: 'u-1', text: 'typed message' }) });
    const renderer = await renderChat();

    await act(async () => {
      findByLabel(renderer.root, 'Message input').props.onChangeText('typed message');
    });
    await act(async () => {
      findByLabel(renderer.root, 'Send message').props.onPress();
    });

    expect(mockApiPost).toHaveBeenCalledWith('/api/v1/groups/dm-1/messages', { text: 'typed message' });
    expect(findByLabel(renderer.root, 'Message input').props.value).toBe('');

    renderer.unmount();
  });

  it('opens the reaction picker without a spring animation when reduce-motion is on', async () => {
    mockReduceMotion = true;
    mockChatApi('dm-1', 'dm', [message({ id: 'm-1', text: 'react to me' })]);
    const springSpy = jest.spyOn(Animated, 'spring');
    const renderer = await renderChat();

    // Long-press the message bubble to open the picker.
    const bubble = renderer.root.findAll((n) => n.props?.delayLongPress === 350)[0];
    expect(bubble).toBeDefined();
    springSpy.mockClear();
    await act(async () => {
      bubble.props.onLongPress();
    });

    // Picker is fully usable…
    expect(renderer.root.findAll((n) => n.props?.accessibilityLabel === 'React with 👍').length).toBeGreaterThan(0);
    // …but appeared in place, with no spring pop.
    expect(springSpy).not.toHaveBeenCalled();

    springSpy.mockRestore();
    renderer.unmount();
  });
});
