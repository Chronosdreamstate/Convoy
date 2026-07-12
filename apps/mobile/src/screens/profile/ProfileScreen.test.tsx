/**
 * Unit tests for the Profile screen's avatar-removal flow and on-accent
 * contrast convention.
 *
 * Requirement 3 (user profile):
 *  - "Remove Photo" must take effect immediately in the UI (initials fallback,
 *    not the old photo) and persist as `avatarUrl: null` on save. Previously
 *    the display fell back to the stale server photo, so the action looked
 *    like a silent no-op.
 *  - ON_ACCENT: text/icons sitting on the crimson accent fill must stay light
 *    in BOTH themes — `colors.text` is near-black in light mode, which made
 *    the Save button and active privacy chip unreadable.
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Alert, StyleSheet } from 'react-native';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../services/SiriShortcutsService', () => ({
  SiriShortcutsService: { donateAll: jest.fn().mockResolvedValue(undefined) },
}));

const mockApiGet = jest.fn();
const mockApiPatch = jest.fn();
jest.mock('../../services/apiClient', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockApiGet(...args),
    patch: (...args: unknown[]) => mockApiPatch(...args),
  },
}));

jest.mock('../../services/AuthService', () => ({
  authService: { signOut: jest.fn().mockResolvedValue(undefined) },
}));

const mockRouterPush = jest.fn();
const mockRouterReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockRouterPush, replace: mockRouterReplace }),
}));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  launchImageLibraryAsync: jest.fn().mockResolvedValue({ canceled: true }),
  MediaTypeOptions: { Images: 'Images' },
}));

jest.mock('expo-file-system/legacy', () => ({
  uploadAsync: jest.fn(),
  FileSystemUploadType: { MULTIPART: 'MULTIPART' },
}));

import ProfileScreen from './ProfileScreen';
import { ThemeProvider } from '../../theme';
import { useAuthStore } from '../../stores/authStore';
import { useSettingsStore } from '../../stores/settingsStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROFILE = {
  id: 'u-1',
  displayName: 'Test Driver',
  phoneNumber: null,
  email: 'driver@example.com',
  avatarUrl: 'https://cdn.example.com/old-avatar.jpg',
  pttCallsign: 'Alpha-1',
  privacy: 'open' as const,
};

function mockProfileApi() {
  mockApiGet.mockImplementation((url: string) => {
    if (url === '/api/v1/users/me') return Promise.resolve({ data: PROFILE });
    if (url === '/api/v1/vehicles') return Promise.resolve({ data: { vehicles: [] } });
    if (url === '/api/v1/friends') return Promise.resolve({ data: { friends: [] } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

async function renderProfile(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ThemeProvider>
        <ProfileScreen />
      </ThemeProvider>,
    );
  });
  // Flush the initial GET /api/v1/users/me load (+ counts fan-out).
  await act(async () => {});
  return renderer;
}

function hasImageWithUri(root: ReactTestInstance, uri: string): boolean {
  return root.findAll((n) => n.props?.source?.uri === uri).length > 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProfileScreen — remove photo', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    useAuthStore.setState({ accessToken: 'tok', token: 'tok' });
    mockProfileApi();
  });

  afterEach(() => {
    alertSpy.mockRestore();
    useSettingsStore.setState({ themeMode: 'system' });
  });

  it('immediately shows the initials fallback and saves avatarUrl: null', async () => {
    const renderer = await renderProfile();
    expect(hasImageWithUri(renderer.root, PROFILE.avatarUrl)).toBe(true);

    // Open the avatar action sheet and choose Remove Photo.
    await act(async () => {
      renderer.root.findAll(
        (n) => n.props?.accessibilityLabel === 'Change profile photo' && typeof n.props?.onPress === 'function',
      )[0].props.onPress();
    });
    const changeCall = alertSpy.mock.calls.find((c) => c[0] === 'Change Photo');
    expect(changeCall).toBeDefined();
    const buttons = changeCall![2] as Array<{ text: string; onPress?: () => void }>;
    const removeBtn = buttons.find((b) => b.text === 'Remove Photo');
    expect(removeBtn?.onPress).toBeDefined();
    await act(async () => {
      removeBtn!.onPress!();
    });

    // The old photo must be gone from the avatar right away — not lingering
    // behind a `?? profile.avatarUrl` fallback until the next reload.
    expect(hasImageWithUri(renderer.root, PROFILE.avatarUrl)).toBe(false);

    // Saving persists the removal.
    mockApiPatch.mockResolvedValue({ data: { ...PROFILE, avatarUrl: null } });
    await act(async () => {
      renderer.root.findAll(
        (n) => n.props?.accessibilityLabel === 'Save profile' && typeof n.props?.onPress === 'function',
      )[0].props.onPress();
    });

    expect(mockApiPatch).toHaveBeenCalledWith(
      '/api/v1/users/me',
      expect.objectContaining({ avatarUrl: null }),
    );
  });
});

describe('ProfileScreen — on-accent contrast (light theme)', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    useAuthStore.setState({ accessToken: 'tok', token: 'tok' });
    mockProfileApi();
  });

  afterEach(() => {
    alertSpy.mockRestore();
    useSettingsStore.setState({ themeMode: 'system' });
  });

  it('keeps text on the accent fill white in light mode', async () => {
    useSettingsStore.setState({ themeMode: 'light' });
    const renderer = await renderProfile();

    // Save button label sits on the solid accent background.
    const saveText = renderer.root.findAll(
      (n) => n.props?.children === 'Save Profile' && n.props?.style != null,
    )[0];
    expect(saveText).toBeDefined();
    expect(StyleSheet.flatten(saveText.props.style).color).toBe('#FFFFFF');

    // The active privacy chip ("Open" for this profile) is accent-filled too.
    const openChipText = renderer.root.findAll(
      (n) => n.props?.children === 'Open' && n.props?.style != null,
    )[0];
    expect(openChipText).toBeDefined();
    expect(StyleSheet.flatten(openChipText.props.style).color).toBe('#FFFFFF');
  });
});
