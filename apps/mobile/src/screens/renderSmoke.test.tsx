/**
 * Render smoke test — every screen must mount without throwing.
 *
 * Twenty screens, including the two the whole product is built around
 * (MapScreen and ConvoyScreen), had no render coverage at all. Their logic was
 * exercised only through services and stores, so a broken import, a destructure
 * of something undefined, or a style referencing a colour that no longer exists
 * would ship as a white screen or a crash — and no test would notice.
 *
 * This is deliberately shallow. It does not assert behaviour; each screen's own
 * suite is the place for that. It asserts the one thing nothing else did: that
 * mounting the screen, letting its effects settle, and unmounting it never
 * throws. Any error logged to the console during a mount fails the test too,
 * since React reports several classes of render bug that way rather than by
 * throwing.
 */

import React from 'react';
import { act, render } from '@testing-library/react-native';

// ---------------------------------------------------------------------------
// Native / platform module stubs. These register native view managers or touch
// device APIs at import time, neither of which exists under jest.
// ---------------------------------------------------------------------------

jest.mock('expo-router', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), setParams: jest.fn() }),
    useLocalSearchParams: () => ({}),
    // Must behave like an effect, not run during render — expo-router's real
    // implementation is useEffect-based, and calling the callback inline makes
    // any screen that setStates on focus re-render forever.
    useFocusEffect: (cb: () => void | (() => void)) => R.useEffect(cb, []),
    router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
    Stack: { Screen: () => null },
    Link: ({ children }: { children?: React.ReactNode }) => children ?? null,
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
    Polygon: stub('Polygon'),
    PROVIDER_DEFAULT: 'default',
    PROVIDER_GOOGLE: 'google',
  };
});

jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  requestBackgroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  getForegroundPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  getCurrentPositionAsync: jest.fn().mockResolvedValue({ coords: { latitude: 51.5, longitude: -0.12 } }),
  watchPositionAsync: jest.fn().mockResolvedValue({ remove: jest.fn() }),
  Accuracy: { Balanced: 3, High: 4, BestForNavigation: 6 },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn().mockResolvedValue(true) }));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(false),
  shareAsync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn().mockResolvedValue({ canceled: true }),
  launchCameraAsync: jest.fn().mockResolvedValue({ canceled: true }),
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  requestCameraPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  MediaTypeOptions: { Images: 'Images' },
}));
jest.mock('expo-media-library', () => ({
  requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  saveToLibraryAsync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('react-native-view-shot', () => ({ captureRef: jest.fn().mockResolvedValue('file:///shot.png') }));
jest.mock('expo-av', () => ({
  Audio: {
    Sound: { createAsync: jest.fn().mockResolvedValue({ sound: { unloadAsync: jest.fn() } }) },
    requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
    setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
    Recording: class { prepareToRecordAsync = jest.fn(); startAsync = jest.fn(); stopAndUnloadAsync = jest.fn(); getURI = () => null; },
  },
}));

// No screen may reach the network in this suite: an unmocked request would make
// the result depend on timing and on whatever a dev machine can dial out to.
jest.mock('../services/apiClient', () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn().mockResolvedValue({ data: {} }),
    patch: jest.fn().mockResolvedValue({ data: {} }),
    put: jest.fn().mockResolvedValue({ data: {} }),
    delete: jest.fn().mockResolvedValue({ data: {} }),
    request: jest.fn().mockResolvedValue({ data: {} }),
  },
}));

// SQLite is a native module; the offline cache opens a database on import.
jest.mock('../services/OfflineCacheService', () => ({
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

import { useAuthStore } from '../stores/authStore';
import { useGroupStore } from '../stores/groupStore';

// ---------------------------------------------------------------------------
// Screens under test
// ---------------------------------------------------------------------------

import AchievementsScreen from './AchievementsScreen';
import ConvoyEndScreen from './ConvoyEndScreen';
import ConvoyHistoryScreen from './ConvoyHistoryScreen';
import EventDetailScreen from './EventDetailScreen';
import FuelLogScreen from './FuelLogScreen';
import GroupChatScreen from './GroupChatScreen';
import GroupLeaderboardScreen from './GroupLeaderboardScreen';
import GroupSettingsScreen from './GroupSettingsScreen';
import GroupStatsScreen from './GroupStatsScreen';
import JoinByCodeScreen from './JoinByCodeScreen';
import NotificationCenterScreen from './NotificationCenterScreen';
import RouteReplayScreen from './RouteReplayScreen';
import SearchScreen from './SearchScreen';
import UserProfileScreen from './UserProfileScreen';
import GarageScreen from './garage/GarageScreen';
import ProfileScreen from './profile/ProfileScreen';
import SettingsScreen from './settings/SettingsScreen';
import ConvoyLobbyScreen from './ConvoyLobbyScreen';
import ConvoyScreen from './ConvoyScreen';
import CreateEventScreen from './CreateEventScreen';
import CreateGroupScreen from './CreateGroupScreen';
import DriveHistoryScreen from './DriveHistoryScreen';
import FriendsScreen from './FriendsScreen';
import GroupBrowseScreen from './GroupBrowseScreen';
import GroupDetailScreen from './GroupDetailScreen';
import GroupEventsScreen from './GroupEventsScreen';
import GroupPhotoLibraryScreen from './GroupPhotoLibraryScreen';
import NearbyScreen from './NearbyScreen';
import WaypointManagementScreen from './WaypointManagementScreen';
import PrivacyPolicyScreen from './legal/PrivacyPolicyScreen';
import TermsScreen from './legal/TermsScreen';
import IdleMapScreen from './map/IdleMapScreen';
import MapScreen from './map/MapScreen';
import AddVehiclePromptScreen from './onboarding/AddVehiclePromptScreen';
import FindGroupPromptScreen from './onboarding/FindGroupPromptScreen';
import PTTTutorialScreen from './onboarding/PTTTutorialScreen';
import BlockedUsersScreen from './settings/BlockedUsersScreen';

const USER_ID = '11111111-1111-1111-1111-111111111111';

/**
 * Screens that need props get them here; the rest take none.
 *
 * Screens that already have behaviour tests are included too. Those suites
 * feed them well-formed fixtures, so none of them ever asked what happens when
 * the server answers 200 with a body the screen did not expect — which is how
 * five list-rendering crashes went unnoticed.
 */
const SCREENS: Array<[string, () => React.ReactElement]> = [
  ['AchievementsScreen', () => <AchievementsScreen />],
  ['ConvoyEndScreen', () => <ConvoyEndScreen />],
  ['ConvoyHistoryScreen', () => <ConvoyHistoryScreen />],
  ['EventDetailScreen', () => <EventDetailScreen />],
  ['FuelLogScreen', () => <FuelLogScreen />],
  ['GroupChatScreen', () => <GroupChatScreen />],
  ['GroupLeaderboardScreen', () => <GroupLeaderboardScreen />],
  ['GroupSettingsScreen', () => <GroupSettingsScreen />],
  ['GroupStatsScreen', () => <GroupStatsScreen />],
  ['JoinByCodeScreen', () => <JoinByCodeScreen />],
  ['NotificationCenterScreen', () => <NotificationCenterScreen />],
  ['RouteReplayScreen', () => <RouteReplayScreen />],
  ['SearchScreen', () => <SearchScreen />],
  ['UserProfileScreen', () => <UserProfileScreen />],
  ['GarageScreen', () => <GarageScreen />],
  ['ProfileScreen', () => <ProfileScreen />],
  ['SettingsScreen', () => <SettingsScreen />],
  ['PrivacyPolicyScreen', () => <PrivacyPolicyScreen />],
  ['TermsScreen', () => <TermsScreen />],
  ['AddVehiclePromptScreen', () => <AddVehiclePromptScreen />],
  ['FindGroupPromptScreen', () => <FindGroupPromptScreen />],
  ['PTTTutorialScreen', () => <PTTTutorialScreen />],
  ['CreateGroupScreen', () => <CreateGroupScreen />],
  ['CreateEventScreen', () => <CreateEventScreen />],
  ['GroupBrowseScreen', () => <GroupBrowseScreen />],
  ['GroupDetailScreen', () => <GroupDetailScreen />],
  ['GroupEventsScreen', () => <GroupEventsScreen />],
  ['GroupPhotoLibraryScreen', () => <GroupPhotoLibraryScreen />],
  ['DriveHistoryScreen', () => <DriveHistoryScreen />],
  ['FriendsScreen', () => <FriendsScreen />],
  ['NearbyScreen', () => <NearbyScreen />],
  ['BlockedUsersScreen', () => <BlockedUsersScreen />],
  ['WaypointManagementScreen', () => <WaypointManagementScreen />],
  ['IdleMapScreen', () => <IdleMapScreen />],
  ['ConvoyScreen', () => <ConvoyScreen userId={USER_ID} />],
  [
    'ConvoyLobbyScreen',
    () => <ConvoyLobbyScreen groupId="g-1" groupName="Canyon Run" onConvoyStart={jest.fn()} />,
  ],
  ['MapScreen', () => <MapScreen groupId="g-1" socketUrl="http://localhost:3000" />],
];

beforeEach(() => {
  useAuthStore.setState({
    user: {
      id: USER_ID,
      displayName: 'Test Driver',
      phoneNumber: null,
      email: 'driver@example.com',
    } as never,
    token: 'test-token',
    accessToken: 'test-token',
    isAuthenticated: true,
    isLoading: false,
  });
  useGroupStore.getState().leaveGroup();
});

afterEach(() => {
  jest.clearAllTimers();
});

describe('every screen mounts, settles and unmounts without throwing', () => {
  it.each(SCREENS)('%s', async (_name, mount) => {
    // React surfaces some render problems (bad element types, invalid style
    // values, updates on unmounted components) through console.error rather
    // than by throwing, so a silent one of those must fail the test too.
    const errors: unknown[][] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args); });

    try {
      // render() already wraps in act; calling it INSIDE act() detaches the
      // renderer in RNTL 13 ("Can't access .root on unmounted test renderer").
      const view = render(mount());
      // Let mount effects (fetches, permission prompts, timers) resolve.
      await act(async () => { await Promise.resolve(); });
      view.unmount();
    } finally {
      spy.mockRestore();
    }

    expect(errors.map((e) => String(e[0]))).toEqual([]);
  });
});
