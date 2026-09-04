/**
 * MapScreen failure paths.
 *
 *  - "Push to Group" (Admin route broadcast) had no in-flight state at all: on
 *    a slow link the button looked dead, so the Admin tapped it again and
 *    POST /groups/:id/route fired twice — the whole convoy got the route
 *    broadcast (and its map redrawn) twice.
 *  - The hazard backfill built its pin map inside a setState updater, which
 *    React runs during the NEXT render — outside the fetch's try/catch. A 200
 *    without a `hazards` array therefore threw a TypeError mid-render and took
 *    the entire map down, mid-drive, instead of degrading to "no backfill".
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

const mockApiGet = jest.fn(async (..._args: unknown[]): Promise<{ data: unknown }> => ({ data: {} }));
const mockApiPost = jest.fn(async (..._args: unknown[]): Promise<{ data: unknown }> => ({ data: {} }));
jest.mock('../../services/apiClient', () => ({
  apiClient: {
    get: (...a: unknown[]) => mockApiGet(...a),
    post: (...a: unknown[]) => mockApiPost(...a),
    patch: jest.fn(async () => ({ data: {} })),
    put: jest.fn(async () => ({ data: {} })),
    delete: jest.fn(async () => ({ data: {} })),
    request: jest.fn(async () => ({ data: {} })),
  },
}));

jest.mock('../../services/OfflineCacheService', () => ({
  // Keep the pure helpers real — the Req 4.4 cached-tile effect calls
  // computeBoundsWithBuffer as soon as a route has more than one point.
  computeBoundsWithBuffer: (
    coords: [number, number][],
  ): [[number, number], [number, number]] => {
    const lngs = coords.map((c) => c[0]);
    const lats = coords.map((c) => c[1]);
    return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
  },
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

const mockSocket = {
  on: jest.fn(),
  off: jest.fn(),
  emit: jest.fn(),
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
import { LocationService } from '../../services/LocationService';

const ME = '11111111-1111-1111-1111-111111111111';

const ROUTE = {
  distance: 12000,
  duration: 900,
  distanceText: '12.0 km',
  durationText: '15 min',
  geometry: { type: 'LineString', coordinates: [[-0.12, 51.5], [-0.13, 51.51]] },
  speedLimitKph: 50,
  speedLimitSegmentsKph: [50],
  congestionSegments: ['low'],
};

/** First pressable carrying this accessibility label (composite + host both match). */
function pressable(root: ReactTestInstance, label: string): ReactTestInstance {
  const node = root.findAll(
    (n) => n.props?.accessibilityLabel === label && typeof n.props?.onPress === 'function',
  )[0];
  expect(node).toBeDefined();
  return node;
}

async function press(root: ReactTestInstance, label: string): Promise<void> {
  const node = pressable(root, label);
  await act(async () => { node.props.onPress(); });
}

/** MapScreen's own position comes from LocationService's registered callback. */
async function deliverFix(): Promise<void> {
  const cb = (LocationService as unknown as {
    _onLocation?: (f: { lat: number; lng: number; heading: number; speedKph: number; ts: number }) => void;
  })._onLocation;
  expect(cb).toBeDefined();
  await act(async () => { cb!({ lat: 51.5, lng: -0.12, heading: 0, speedKph: 0, ts: Date.now() }); });
}

async function mountMap(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  // groupId/socketUrl are PROPS (supplied by app/(tabs)/map.tsx) and the socket
  // effect also gates on authStore.token — without all three the screen mounts
  // but wires nothing up.
  await act(async () => {
    renderer = TestRenderer.create(<MapScreen groupId="g-1" socketUrl="http://api.test" isAdmin />);
  });
  await act(async () => {});
  return renderer;
}

/** Opens the FAB, the Plan Route modal, and calculates a route. */
async function openRoutePlannerWithAlternatives(root: ReactTestInstance): Promise<void> {
  await press(root, 'Open actions menu');
  await press(root, 'Plan route');

  const input = root.findAll((n) => n.props?.placeholder === 'Enter destination')[0];
  expect(input).toBeDefined();
  await act(async () => { input.props.onChangeText('Brighton'); });

  await press(root, 'Calculate route');
  await act(async () => {});
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApiGet.mockImplementation(async (url: unknown) => {
    if (typeof url === 'string' && url.startsWith('/api/v1/places/search')) {
      return { data: [{ lat: 50.82, lng: -0.13, name: 'Brighton' }]};
    }
    return { data: {} };
  });
  mockApiPost.mockImplementation(async (url: unknown) => {
    if (url === '/api/v1/routes/calculate') return { data: { routes: [ROUTE] }};
    return { data: {} };
  });
  useAuthStore.setState({
    user: { id: ME, displayName: 'Alex', phoneNumber: null, email: null, avatarUrl: null, callsign: null } as never,
    accessToken: 'token-1',
    token: 'token-1',
    isAuthenticated: true,
  } as never);
  useGroupStore.setState({ activeGroupId: 'g-1', activeGroupName: 'Canyon Run' } as never);
});

describe('MapScreen — pushing a route to the group', () => {
  it('sends exactly one broadcast when the Admin double-taps Push to Group', async () => {
    const renderer = await mountMap();
    await deliverFix();
    await openRoutePlannerWithAlternatives(renderer.root);

    // Hold the push in flight so the second tap lands while the first is
    // outstanding — exactly the slow-link case that produced a double push.
    let release!: () => void;
    mockApiPost.mockImplementation(async (url: unknown) => {
      if (url === '/api/v1/routes/calculate') return { data: { routes: [ROUTE] }};
      if (url === '/api/v1/groups/g-1/route') {
        await new Promise<void>((resolve) => { release = resolve; });
        return { data: {} };
      }
      return { data: {} };
    });

    const push = pressable(renderer.root, 'Push selected route to all group members');
    await act(async () => { push.props.onPress(); });

    // While in flight the control reports itself busy and refuses further taps.
    const busy = pressable(renderer.root, 'Pushing route to group');
    expect(busy.props.accessibilityState).toEqual({ disabled: true, busy: true });
    await act(async () => { busy.props.onPress(); });

    await act(async () => { release(); });

    const routePosts = mockApiPost.mock.calls.filter((c) => c[0] === '/api/v1/groups/g-1/route');
    expect(routePosts).toHaveLength(1);

    renderer.unmount();
  });

  it('re-arms the button after a failed push so the Admin can retry', async () => {
    const renderer = await mountMap();
    await deliverFix();
    await openRoutePlannerWithAlternatives(renderer.root);

    mockApiPost.mockImplementation(async (url: unknown) => {
      if (url === '/api/v1/routes/calculate') return { data: { routes: [ROUTE] }};
      if (url === '/api/v1/groups/g-1/route') throw new Error('offline');
      return { data: {} };
    });

    await press(renderer.root, 'Push selected route to all group members');

    // The busy state must not stick — a failed push that left the button
    // disabled would strand the Admin with no way to try again.
    const again = pressable(renderer.root, 'Push selected route to all group members');
    expect(again.props.accessibilityState).toEqual({ disabled: false, busy: false });

    await act(async () => { again.props.onPress(); });
    const routePosts = mockApiPost.mock.calls.filter((c) => c[0] === '/api/v1/groups/g-1/route');
    expect(routePosts).toHaveLength(2);

    renderer.unmount();
  });
});

describe('MapScreen — hazard backfill with a malformed payload', () => {
  it('survives a 200 that carries no hazards array', async () => {
    // GET /hazards answers 200 with an unexpected shape (the default mock
    // returns `{}`). The backfill is best-effort — the live socket push is the
    // primary delivery path — so this must degrade quietly, not crash render.
    const renderer = await mountMap();

    await expect(deliverFix()).resolves.toBeUndefined();
    await act(async () => {});

    // Still mounted and interactive.
    expect(pressable(renderer.root, 'Open actions menu')).toBeDefined();

    renderer.unmount();
  });

  it('still applies a well-formed backfill', async () => {
    mockApiGet.mockImplementation(async (url: unknown) => {
      if (url === '/api/v1/hazards') {
        return {
          data: {
            hazards: [{
              id: 'h-1',
              type: 'pothole',
              lat: 51.5,
              lng: -0.12,
              confirmationCount: 2,
              dismissalCount: 0,
              createdAt: new Date().toISOString(),
            }],
          },
       };
      }
      return { data: {} };
    });

    const renderer = await mountMap();
    await deliverFix();
    await act(async () => {});

    // The pin's vote controls only exist once the hazard landed in state.
    expect(pressable(renderer.root, 'Confirm hazard still there, 2 votes')).toBeDefined();

    renderer.unmount();
  });
});
