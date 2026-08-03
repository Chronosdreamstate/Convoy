/**
 * MapScreen — SOS acknowledgement over the socket.
 *
 * The server has relayed `sos:acknowledged` to the group room and to the
 * sender's own room since SOS shipped, and this screen never listened: a rider
 * who tapped "I'm responding" told nobody, and the person in trouble watched a
 * screen that never changed. These tests drive the real socket handlers via a
 * faked WebSocketService.
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Native-module mocks (same set the render-smoke suite needs to mount MapScreen)
// ---------------------------------------------------------------------------

jest.mock('expo-router', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), setParams: jest.fn() }),
    useLocalSearchParams: () => ({ groupId: 'g-1', groupName: 'Canyon Run' }),
    useFocusEffect: (cb: () => void | (() => void)) => R.useEffect(cb, []),
    router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
    Stack: { Screen: () => null },
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children?: React.ReactNode }) => children ?? null,
  SafeAreaView: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

jest.mock('react-native-maps', () => {
  const { View } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: View,
    Marker: View,
    Polyline: View,
    Circle: View,
    Callout: View,
    PROVIDER_DEFAULT: 'default',
    PROVIDER_GOOGLE: 'google',
  };
});

jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  requestBackgroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  getCurrentPositionAsync: jest.fn().mockResolvedValue({ coords: { latitude: 51.5, longitude: -0.12, heading: 0, speed: 0 } }),
  watchPositionAsync: jest.fn().mockResolvedValue({ remove: jest.fn() }),
  Accuracy: { High: 4, Balanced: 3 },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue('token-1'),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn().mockResolvedValue(false), shareAsync: jest.fn() }));
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  launchImageLibraryAsync: jest.fn(),
  MediaTypeOptions: { Images: 'Images' },
}));
jest.mock('expo-media-library', () => ({
  requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  saveToLibraryAsync: jest.fn(),
}));
jest.mock('react-native-view-shot', () => ({ captureRef: jest.fn().mockResolvedValue('file:///shot.png') }));
jest.mock('expo-av', () => ({
  Audio: {
    requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
    setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
    Recording: class { prepareToRecordAsync = jest.fn(); startAsync = jest.fn(); stopAndUnloadAsync = jest.fn(); getURI = () => null; },
    Sound: { createAsync: jest.fn().mockResolvedValue({ sound: { playAsync: jest.fn(), unloadAsync: jest.fn() } }) },
  },
}));

jest.mock('../../services/apiClient', () => ({
  apiClient: {
    get: jest.fn(async () => ({ data: {} })),
    post: jest.fn(async () => ({ data: {} })),
    patch: jest.fn(async () => ({ data: {} })),
    put: jest.fn(async () => ({ data: {} })),
    delete: jest.fn(async () => ({ data: {} })),
    request: jest.fn(async () => ({ data: {} })),
  },
}));

jest.mock('../../services/OfflineCacheService', () => ({
  SQLiteOfflineDB: class {
    init = jest.fn().mockResolvedValue(undefined);
    getPendingHazards = jest.fn().mockResolvedValue([]);
    clearHazards = jest.fn().mockResolvedValue(undefined);
    saveHazard = jest.fn().mockResolvedValue(undefined);
    getPendingDrives = jest.fn().mockResolvedValue([]);
    clearDrives = jest.fn().mockResolvedValue(undefined);
    saveDrive = jest.fn().mockResolvedValue(undefined);
    saveLastPosition = jest.fn().mockResolvedValue(undefined);
    getLastPositions = jest.fn().mockResolvedValue([]);
  },
}));

// ---------------------------------------------------------------------------
// Fake socket — records every handler the screen registers so tests can fire
// server events at the real code.
// ---------------------------------------------------------------------------

type Handler = (payload?: unknown) => void;
const handlers = new Map<string, Handler[]>();
const emitted: Array<{ event: string; payload: unknown }> = [];

const mockSocket = {
  on: (event: string, fn: Handler) => { handlers.set(event, [...(handlers.get(event) ?? []), fn]); },
  off: (event: string, fn?: Handler) => {
    if (!fn) { handlers.delete(event); return; }
    handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== fn));
  },
  emit: (event: string, payload?: unknown) => { emitted.push({ event, payload }); },
  connected: true,
  disconnect: jest.fn(),
};

jest.mock('../../services/WebSocketService', () => ({
  WebSocketService: class {
    connect() { return mockSocket; }
    disconnect = jest.fn();
    emitLocation = jest.fn();
    getSocket = () => mockSocket;
  },
}));

import MapScreen from './MapScreen';
import { useAuthStore } from '../../stores/authStore';
import { useGroupStore } from '../../stores/groupStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ME = '11111111-1111-1111-1111-111111111111';
const RESCUER = '22222222-2222-2222-2222-222222222222';

async function fire(event: string, payload: unknown): Promise<void> {
  const fns = handlers.get(event) ?? [];
  if (fns.length === 0) throw new Error(`MapScreen registered no handler for "${event}"`);
  await act(async () => { fns.forEach((fn) => fn(payload)); });
}

async function mountMap(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  // groupId/socketUrl are PROPS (supplied by app/(tabs)/map.tsx) and the socket
  // effect also gates on authStore.token — without all three the screen mounts
  // but registers no handlers at all, and every assertion below would pass
  // vacuously.
  await act(async () => {
    renderer = TestRenderer.create(<MapScreen groupId="g-1" socketUrl="http://api.test" />);
  });
  await act(async () => {});
  return renderer;
}

function allTexts(root: ReactTestInstance): string[] {
  return root
    .findAll((n) => n.props?.children !== undefined)
    .map((n) => {
      const children = n.props.children;
      return Array.isArray(children) ? children.join('') : String(children);
    });
}

function hasTextContaining(root: ReactTestInstance, fragment: string): boolean {
  return allTexts(root).some((t) => t.includes(fragment));
}

/** The responder count lives on the cancel control inside the actions menu. */
async function openActionsMenu(root: ReactTestInstance): Promise<void> {
  const toggle = root.findAll(
    (n) => n.props?.accessibilityLabel === 'Open actions menu' && typeof n.props?.onPress === 'function',
  )[0];
  await act(async () => { toggle.props.onPress(); });
}

function cancelSosLabel(root: ReactTestInstance): string | undefined {
  const node = root.findAll(
    (n) => typeof n.props?.accessibilityLabel === 'string'
      && n.props.accessibilityLabel.startsWith('Cancel SOS')
      && typeof n.props?.onPress === 'function',
  )[0];
  return node?.props.accessibilityLabel as string | undefined;
}

const sosPin = (id: string, userId: string) => ({
  id,
  userId,
  lat: 51.5,
  lng: -0.12,
  createdAt: new Date().toISOString(),
  senderName: userId === ME ? 'Me' : 'Sam',
});

beforeEach(() => {
  handlers.clear();
  emitted.length = 0;
  useAuthStore.setState({
    user: { id: ME, displayName: 'Alex', phoneNumber: null, email: null, avatarUrl: null, callsign: null } as never,
    accessToken: 'token-1',
    token: 'token-1',
    isAuthenticated: true,
  } as never);
  useGroupStore.setState({ activeGroupId: 'g-1', activeGroupName: 'Canyon Run' } as never);
});

// ---------------------------------------------------------------------------

describe('MapScreen SOS acknowledgement', () => {
  it('registers a handler for the acknowledgement the server broadcasts', async () => {
    await mountMap();
    expect(handlers.has('sos:acknowledged')).toBe(true);
  });

  it('adopts my own SOS from the server echo so it can still be cancelled', async () => {
    // confirmSos sets this optimistically; if its response was lost the sender
    // had a live pin and no way to clear it.
    const renderer = await mountMap();

    await fire('sos:alert', sosPin('sos-1', ME));
    await openActionsMenu(renderer.root);

    expect(cancelSosLabel(renderer.root)).toBe('Cancel SOS');
  });

  it('tells the rider who raised the SOS that help is coming, and counts responders', async () => {
    const renderer = await mountMap();

    // My own SOS is live.
    await fire('sos:alert', sosPin('sos-1', ME));
    await fire('sos:acknowledged', { sosId: 'sos-1', memberName: 'Sam', acknowledgedBy: RESCUER });

    expect(hasTextContaining(renderer.root, 'is on the way')).toBe(true);
    // The banner fades; the count on the cancel control is what persists.
    await openActionsMenu(renderer.root);
    expect(hasTextContaining(renderer.root, 'SOS · 1')).toBe(true);
    expect(cancelSosLabel(renderer.root)).toBe('Cancel SOS. 1 member is responding.');
  });

  it('counts each responder once, however many times the event arrives', async () => {
    const renderer = await mountMap();
    await fire('sos:alert', sosPin('sos-1', ME));

    await fire('sos:acknowledged', { sosId: 'sos-1', acknowledgedBy: RESCUER });
    await fire('sos:acknowledged', { sosId: 'sos-1', acknowledgedBy: RESCUER });

    await openActionsMenu(renderer.root);
    expect(hasTextContaining(renderer.root, 'SOS · 1')).toBe(true);
    expect(hasTextContaining(renderer.root, 'SOS · 2')).toBe(false);
  });

  it('does not narrate my own acknowledgement back to me', async () => {
    const renderer = await mountMap();
    await fire('sos:alert', sosPin('sos-2', RESCUER));

    await fire('sos:acknowledged', { sosId: 'sos-2', acknowledgedBy: ME });

    expect(hasTextContaining(renderer.root, 'is responding to the SOS')).toBe(false);
  });

  it('lets the rest of the convoy see that someone already responded', async () => {
    const renderer = await mountMap();
    await fire('sos:alert', sosPin('sos-2', RESCUER));

    await fire('sos:acknowledged', { sosId: 'sos-2', memberName: 'Sam', acknowledgedBy: '33333333-3333-3333-3333-333333333333' });

    expect(hasTextContaining(renderer.root, 'is responding to the SOS')).toBe(true);
  });

  it('shows the convoy when a rider reaches a waypoint, without echoing their text', async () => {
    // The server relays this to the rest of the group; nothing listened, so a
    // photo stop reached no one. The relayed `message` comes from the sender's
    // device, so it must not be rendered verbatim.
    const renderer = await mountMap();

    await fire('waypoint:reached', {
      waypointId: 'w-1',
      type: 'photo_stop',
      message: '<script>not rendered</script>',
      userId: RESCUER,
    });

    expect(hasTextContaining(renderer.root, 'stopped for photos')).toBe(true);
    expect(hasTextContaining(renderer.root, 'not rendered')).toBe(false);
  });

  it('forgets responders once the SOS is cancelled', async () => {
    const renderer = await mountMap();
    await fire('sos:alert', sosPin('sos-1', ME));
    await fire('sos:acknowledged', { sosId: 'sos-1', acknowledgedBy: RESCUER });
    await openActionsMenu(renderer.root);
    expect(hasTextContaining(renderer.root, 'SOS · 1')).toBe(true);

    await fire('sos:cancelled', { sosId: 'sos-1' });

    expect(hasTextContaining(renderer.root, 'SOS · 1')).toBe(false);
    expect(cancelSosLabel(renderer.root)).toBeUndefined(); // back to the SOS button
  });
});
