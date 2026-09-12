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

  it('the photo-URL prompt prefill respects a staged removal instead of resurrecting the old URL', async () => {
    const renderer = await renderProfile();

    /** Opens the avatar action sheet and presses the given button (from the latest sheet). */
    async function pressSheetButton(text: string) {
      await act(async () => {
        renderer.root.findAll(
          (n) => n.props?.accessibilityLabel === 'Change profile photo' && typeof n.props?.onPress === 'function',
        )[0].props.onPress();
      });
      const call = [...alertSpy.mock.calls].reverse().find((c) => c[0] === 'Change Photo');
      expect(call).toBeDefined();
      const buttons = call![2] as Array<{ text: string; onPress?: () => void }>;
      const btn = buttons.find((b) => b.text === text);
      expect(btn?.onPress).toBeDefined();
      await act(async () => {
        btn!.onPress!();
      });
    }

    function urlInput() {
      return renderer.root.findAll((n) => n.props?.accessibilityLabel === 'Avatar photo URL')[0];
    }

    // No staged change yet → the prompt prefills the current server photo.
    await pressSheetButton('Enter Photo URL');
    expect(urlInput().props.value).toBe(PROFILE.avatarUrl);
    await act(async () => {
      renderer.root.findAll(
        (n) => n.props?.accessibilityLabel === 'Cancel photo URL' && typeof n.props?.onPress === 'function',
      )[0].props.onPress();
    });

    // Stage a removal, then reopen the prompt — it must start empty, not
    // prefill the URL the user just removed.
    await pressSheetButton('Remove Photo');
    await pressSheetButton('Enter Photo URL');
    expect(urlInput().props.value).toBe('');
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

// ---------------------------------------------------------------------------
// Avatar upload failures must not read as success
// ---------------------------------------------------------------------------

const imagePicker = jest.requireMock('expo-image-picker') as {
  requestMediaLibraryPermissionsAsync: jest.Mock;
  launchImageLibraryAsync: jest.Mock;
};
const fileSystem = jest.requireMock('expo-file-system/legacy') as { uploadAsync: jest.Mock };

describe('ProfileScreen — avatar upload failure', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    useAuthStore.setState({ accessToken: 'tok', token: 'tok' });
    mockProfileApi();
    imagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ status: 'granted' });
    imagePicker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///huge.jpg', mimeType: 'image/jpeg' }],
    });
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  /** Opens the avatar sheet and taps "Choose from Library". */
  async function pickFromLibrary(renderer: TestRenderer.ReactTestRenderer) {
    await act(async () => {
      renderer.root.findAll(
        (n) => n.props?.accessibilityLabel === 'Change profile photo' && typeof n.props?.onPress === 'function',
      )[0].props.onPress();
    });
    const call = [...alertSpy.mock.calls].reverse().find((c) => c[0] === 'Change Photo');
    const buttons = call![2] as Array<{ text: string; onPress?: () => void }>;
    const libraryBtn = buttons.find((b) => b.text.includes('Choose from Library'))!;
    await act(async () => { libraryBtn.onPress!(); });
    await act(async () => {});
  }

  function saveButton(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance {
    return renderer.root.findAll(
      (n) => n.props?.accessibilityLabel === 'Save profile' && typeof n.props?.onPress === 'function',
    )[0];
  }

  it('surfaces a rejected upload instead of silently dropping the photo', async () => {
    // uploadAsync RESOLVES for 4xx/5xx. The old code read `.url` straight off
    // the parsed body, so a 413 staged `undefined`, the avatar fell back to
    // initials with no error, and Save then reported success.
    fileSystem.uploadAsync.mockResolvedValue({
      status: 413,
      body: JSON.stringify({ error: 'File too large (max 10 MB)' }),
    });
    const renderer = await renderProfile();

    await pickFromLibrary(renderer);

    expect(alertSpy).toHaveBeenCalledWith('Upload Failed', 'File too large (max 10 MB)');
    // Nothing was staged, so there is no phantom change to "save".
    expect(saveButton(renderer).props.accessibilityState.disabled).toBe(true);
    expect(mockApiPatch).not.toHaveBeenCalled();
  });

  it('stages the photo and enables Save when the upload really succeeds', async () => {
    fileSystem.uploadAsync.mockResolvedValue({
      status: 201,
      body: JSON.stringify({ url: 'https://cdn.example.com/new-avatar.jpg' }),
    });
    const renderer = await renderProfile();

    await pickFromLibrary(renderer);

    expect(alertSpy).not.toHaveBeenCalledWith('Upload Failed', expect.anything());
    expect(hasImageWithUri(renderer.root, 'https://cdn.example.com/new-avatar.jpg')).toBe(true);
    expect(saveButton(renderer).props.accessibilityState.disabled).toBe(false);
  });
});

/**
 * PATCH /users/me validates every field in the body, and display names the
 * *server* minted at sign-up need not satisfy those rules: it takes the
 * email's local part verbatim (auth.service.ts `email.split('@')[0]`), with no
 * length cap and no profanity check — while patchMeSchema caps the name at 50
 * characters and rejects banned words.
 *
 * This screen used to put `displayName` in every save body, so a user who
 * signed up as e.g. `smart.ass.racer@example.com` could not change their
 * callsign or privacy at all: each Save came back "Display name contains
 * disallowed words" about a field they never touched.
 */
describe('ProfileScreen — saving a field other than the name', () => {
  const SERVER_MINTED = {
    ...PROFILE,
    // What the API assigns for smart.ass.racer@example.com — patchMeSchema's
    // whole-word profanity filter rejects it on the way back in.
    displayName: 'smart.ass.racer',
    pttCallsign: null,
  };

  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    useAuthStore.setState({ accessToken: 'tok', token: 'tok' });
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/v1/users/me') return Promise.resolve({ data: SERVER_MINTED });
      if (url === '/api/v1/vehicles') return Promise.resolve({ data: { vehicles: [] } });
      if (url === '/api/v1/friends') return Promise.resolve({ data: { friends: [] } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    // Stand in for patchMeSchema: any displayName in the body is validated.
    mockApiPatch.mockImplementation(async (_url: string, body: Record<string, unknown>) => {
      const name = body.displayName;
      if (typeof name === 'string' && /\b(fuck|shit|ass)\b/i.test(name)) {
        throw { response: { data: { message: 'Display name contains disallowed words' } } };
      }
      return { data: { ...SERVER_MINTED, ...body } };
    });
  });

  afterEach(() => { alertSpy.mockRestore(); });

  function findByLabel(root: ReactTestInstance, label: string, prop: string): ReactTestInstance {
    const node = root.findAll(
      (n) => n.props?.accessibilityLabel === label && typeof n.props?.[prop] === 'function',
    )[0];
    expect(node).toBeDefined();
    return node;
  }

  function hasText(root: ReactTestInstance, text: string): boolean {
    return root.findAll((n) => {
      const c = n.props?.children;
      return (Array.isArray(c) ? c.join('') : c) === text;
    }).length > 0;
  }

  it('does not resend an untouched server-minted name, so the callsign saves', async () => {
    const renderer = await renderProfile();

    await act(async () => {
      findByLabel(renderer.root, 'PTT callsign input', 'onChangeText').props.onChangeText('Bravo-2');
    });
    await act(async () => {
      findByLabel(renderer.root, 'Save profile', 'onPress').props.onPress();
    });

    expect(mockApiPatch).toHaveBeenCalledTimes(1);
    const [, body] = mockApiPatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).not.toHaveProperty('displayName');
    expect(body.pttCallsign).toBe('Bravo-2');
    expect(hasText(renderer.root, 'Display name contains disallowed words')).toBe(false);
    expect(hasText(renderer.root, 'Profile saved successfully.')).toBe(true);
  });

  it('still sends — and still surfaces the rule for — a name the user edits', async () => {
    const renderer = await renderProfile();

    await act(async () => {
      findByLabel(renderer.root, 'Edit display name', 'onPress').props.onPress();
    });
    await act(async () => {
      findByLabel(renderer.root, 'Display name input', 'onChangeText').props.onChangeText('total.ass.hat');
    });
    await act(async () => {
      findByLabel(renderer.root, 'Save profile', 'onPress').props.onPress();
    });

    const [, body] = mockApiPatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.displayName).toBe('total.ass.hat');
    expect(hasText(renderer.root, 'Display name contains disallowed words')).toBe(true);
  });
});
