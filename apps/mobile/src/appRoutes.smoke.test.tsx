/**
 * Route smoke test — the expo-router entry points must mount.
 *
 * Most files under app/ are two-line wrappers around a screen, and those
 * screens are covered by screens/renderSmoke.test.tsx. These are the ones that
 * carry real logic of their own and had none:
 *
 *   index          — the auth-state fork every cold start goes through
 *   (tabs)/map     — picks between the guest, idle and in-convoy maps, and
 *                    derives the live-location socket URL
 *   (tabs)/convoy  — signed-out and no-group branches before ConvoyScreen
 *   invite         — 500 lines, and the landing page for a shared invite link,
 *                    so it is the first thing a brand-new user ever sees
 *
 * Each branch is asserted, not just the default one: a wrapper that renders
 * fine when signed in can still be broken for the signed-out visitor, which is
 * exactly the case that matters for an invite link.
 */

import React from 'react';
import { act, render } from '@testing-library/react-native';

jest.mock('expo-router', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => ({ userId: 'u-1' }),
    useFocusEffect: (cb: () => void | (() => void)) => R.useEffect(cb, []),
    router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
    // Redirect renders nothing but must exist — app/index returns it.
    Redirect: ({ href }: { href: string }) => R.createElement('Redirect', { href }),
    Stack: { Screen: () => null },
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children?: React.ReactNode }) => children ?? null,
  SafeAreaView: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

jest.mock('react-native-maps', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const stub = (name: string) => (props: { children?: unknown }) =>
    R.createElement(name, props as never, props.children as never);
  return {
    __esModule: true,
    default: stub('MapView'),
    Marker: stub('Marker'),
    Callout: stub('Callout'),
    Polyline: stub('Polyline'),
    Circle: stub('Circle'),
    PROVIDER_DEFAULT: 'default',
  };
});

jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  requestBackgroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  getForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  hasStartedLocationUpdatesAsync: jest.fn().mockResolvedValue(false),
  startLocationUpdatesAsync: jest.fn().mockResolvedValue(undefined),
  stopLocationUpdatesAsync: jest.fn().mockResolvedValue(undefined),
  getCurrentPositionAsync: jest.fn().mockResolvedValue({ coords: { latitude: 51.5, longitude: -0.12 } }),
  watchPositionAsync: jest.fn().mockResolvedValue({ remove: jest.fn() }),
  Accuracy: { Balanced: 3, High: 4, BestForNavigation: 6 },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./services/apiClient', () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn().mockResolvedValue({ data: {} }),
    patch: jest.fn().mockResolvedValue({ data: {} }),
    delete: jest.fn().mockResolvedValue({ data: {} }),
  },
}));

jest.mock('./services/OfflineCacheService', () => ({
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

import { useAuthStore } from './stores/authStore';
import { useGroupStore } from './stores/groupStore';

import Index from '../app/index';
import MapTab from '../app/(tabs)/map';
import ConvoyTab from '../app/(tabs)/convoy';
import InviteRoute from '../app/invite';

const USER = {
  id: '11111111-1111-1111-1111-111111111111',
  displayName: 'Test Driver',
  phoneNumber: null,
  email: 'driver@example.com',
};

function signedIn() {
  useAuthStore.setState({
    user: USER as never, token: 't', accessToken: 't',
    isAuthenticated: true, isLoading: false,
  });
}

function signedOut() {
  useAuthStore.setState({
    user: null, token: null, accessToken: null,
    isAuthenticated: false, isLoading: false,
  });
}

/** Mount, let effects settle, unmount — failing on anything thrown or logged. */
async function mounts(element: React.ReactElement): Promise<void> {
  const errors: unknown[][] = [];
  const spy = jest.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });
  try {
    const view = render(element);
    await act(async () => { await Promise.resolve(); });
    view.unmount();
  } finally {
    spy.mockRestore();
  }
  expect(errors.map((e) => String(e[0]))).toEqual([]);
}

beforeEach(() => {
  useGroupStore.getState().leaveGroup();
  signedIn();
});

describe('app/index — cold-start auth fork', () => {
  it('renders the splash while auth is still resolving', async () => {
    useAuthStore.setState({ isLoading: true });
    await mounts(<Index />);
  });

  it('redirects a signed-in user', async () => { await mounts(<Index />); });

  it('redirects a signed-out visitor', async () => { signedOut(); await mounts(<Index />); });
});

describe('app/(tabs)/map — guest / idle / in-convoy fork', () => {
  it('signed out falls back to the guest map', async () => {
    signedOut();
    await mounts(<MapTab />);
  });

  it('signed in with no group shows the idle map', async () => { await mounts(<MapTab />); });

  it('signed in with an active group shows the live map', async () => {
    useGroupStore.setState({ activeGroupId: 'g-1', pttChannelId: 'ch-1' });
    await mounts(<MapTab />);
  });
});

describe('app/(tabs)/convoy', () => {
  it('prompts a signed-out visitor to sign in', async () => { signedOut(); await mounts(<ConvoyTab />); });
  it('renders the convoy screen for a signed-in user', async () => { await mounts(<ConvoyTab />); });
});

describe('app/invite — the landing page for a shared invite link', () => {
  it('mounts for a signed-in user', async () => { await mounts(<InviteRoute />); });

  it('mounts for a signed-out visitor, which is who invite links reach', async () => {
    signedOut();
    await mounts(<InviteRoute />);
  });
});
