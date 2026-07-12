/**
 * Unit tests for the Settings screen's delete-account flow.
 *
 * Requirement 42 (data retention / account deletion) + Requirement 16 (settings):
 *  - SUCCESS: confirming deletion calls DELETE /api/v1/account, clears all
 *    auth state via the shared authService.signOut() reset path (which also
 *    resets the per-account stores), and deterministically navigates to the
 *    (auth) welcome screen instead of relying only on the root layout's
 *    redirect effect.
 *  - Local-cleanup failure after a successful server deletion still clears
 *    the in-memory session (root layout redirect condition) and navigates —
 *    it must NOT resurface as a "deletion failed" error.
 *  - FAILURE: a failed DELETE shows an error alert, leaves the session fully
 *    intact (no signOut, no navigation), and re-enables the row for retry.
 */

import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';
import { Alert, Animated } from 'react-native';

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
const mockApiDelete = jest.fn();
jest.mock('../../services/apiClient', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockApiGet(...args),
    patch: (...args: unknown[]) => mockApiPatch(...args),
    delete: (...args: unknown[]) => mockApiDelete(...args),
  },
}));

const mockAuthSignOut = jest.fn();
jest.mock('../../services/AuthService', () => ({
  authService: { signOut: (...args: unknown[]) => mockAuthSignOut(...args) },
}));

const mockRouterReplace = jest.fn();
const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockRouterReplace, push: mockRouterPush }),
}));

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(false),
  shareAsync: jest.fn().mockResolvedValue(undefined),
}));

// Controllable OS reduce-motion flag — default (false) matches the real
// hook's pre-probe state, so the delete-account tests are unaffected.
let mockReduceMotion = false;
jest.mock('../../hooks/useReduceMotion', () => ({
  useReduceMotion: () => mockReduceMotion,
}));

import SettingsScreen from './SettingsScreen';
import { useAuthStore, User } from '../../stores/authStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SETTINGS_RESPONSE = {
  data: {
    hazardAlertDistanceM: 805,
    tileCacheLimitMb: 500,
    scenicRouting: false,
    mapStyle: 'standard',
    notifHazard: true,
    notifGroupEvents: true,
    notifFriendRequests: true,
    notifNavigation: true,
    visibleToNearby: false,
    shareLocationWithFriends: false,
  },
};

const TEST_USER: User = { id: 'u-1', displayName: 'Test Driver', privacy: 'open' };

function signInTestUser() {
  useAuthStore.setState({
    user: TEST_USER,
    accessToken: 'tok',
    token: 'tok',
    isAuthenticated: true,
    isFirstLogin: false,
    isLoading: false,
  });
}

async function renderSettings(): Promise<ReactTestInstance> {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(<SettingsScreen />);
  });
  // Flush the initial GET /api/v1/settings load.
  await act(async () => {});
  return renderer.root;
}

/** Presses the Delete Account row and confirms the destructive alert. */
async function confirmDeleteAccount(root: ReactTestInstance, alertSpy: jest.SpyInstance) {
  const deleteRow = root.findAll(
    (n) => n.props?.accessibilityLabel === 'Delete Account' && typeof n.props?.onPress === 'function',
  )[0];
  expect(deleteRow).toBeDefined();

  await act(async () => {
    deleteRow.props.onPress();
  });

  // First alert is the confirmation dialog — press its "Delete" button.
  const confirmCall = alertSpy.mock.calls.find((c) => c[0] === 'Delete Account');
  expect(confirmCall).toBeDefined();
  const buttons = confirmCall![2] as Array<{ text: string; onPress?: () => Promise<void> }>;
  const confirm = buttons.find((b) => b.text === 'Delete');
  expect(confirm?.onPress).toBeDefined();

  await act(async () => {
    await confirm!.onPress!();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SettingsScreen — delete account', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockApiGet.mockResolvedValue(SETTINGS_RESPONSE);
    signInTestUser();
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it('on success: deletes the account, clears auth state via the sign-out reset path, and navigates to welcome', async () => {
    mockApiDelete.mockResolvedValue({ data: { message: 'deleted' } });
    // Real sign-out behaviour: resets the auth store (per-account stores are
    // reset by the same AuthService.signOut path, covered by its own tests).
    mockAuthSignOut.mockImplementation(async () => {
      useAuthStore.getState().signOut();
    });

    const root = await renderSettings();
    await confirmDeleteAccount(root, alertSpy);

    expect(mockApiDelete).toHaveBeenCalledWith('/api/v1/account');
    expect(mockAuthSignOut).toHaveBeenCalledTimes(1);

    // Root layout redirect condition: !isLoading && !isAuthenticated
    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(false);
    expect(s.user).toBeNull();
    expect(s.accessToken).toBeNull();
    expect(s.isLoading).toBe(false);

    // Deterministic navigation to the auth group (not just the redirect effect)
    expect(mockRouterReplace).toHaveBeenCalledWith('/(auth)/welcome');

    // No spurious "deletion failed" error
    const errorCalls = alertSpy.mock.calls.filter((c) => c[0] === 'Error');
    expect(errorCalls).toHaveLength(0);
  });

  it('on success but local sign-out failure: still clears the in-memory session and navigates', async () => {
    mockApiDelete.mockResolvedValue({ data: { message: 'deleted' } });
    mockAuthSignOut.mockRejectedValue(new Error('keychain locked'));

    const root = await renderSettings();
    await confirmDeleteAccount(root, alertSpy);

    // Fallback path must clear the auth store so the root layout's auth
    // guard can never see stale authenticated state.
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
    expect(mockRouterReplace).toHaveBeenCalledWith('/(auth)/welcome');

    // Deletion already succeeded server-side — no error alert.
    const errorCalls = alertSpy.mock.calls.filter((c) => c[0] === 'Error');
    expect(errorCalls).toHaveLength(0);
  });

  it('on failure: shows an error, leaves the session intact, and does not navigate', async () => {
    mockApiDelete.mockRejectedValue(new Error('500 Internal Server Error'));

    const root = await renderSettings();
    await confirmDeleteAccount(root, alertSpy);

    expect(mockApiDelete).toHaveBeenCalledWith('/api/v1/account');

    // Error surfaced to the user
    expect(alertSpy).toHaveBeenCalledWith('Error', 'Failed to delete account. Please try again.');

    // Session fully intact — no local sign-out, no navigation
    expect(mockAuthSignOut).not.toHaveBeenCalled();
    expect(mockRouterReplace).not.toHaveBeenCalled();
    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(true);
    expect(s.user).toEqual(TEST_USER);
    expect(s.accessToken).toBe('tok');

    // Row is re-enabled for retry (isDeletingAccount reset)
    const deleteRow = root.findAll(
      (n) => n.props?.accessibilityLabel === 'Delete Account' && typeof n.props?.onPress === 'function',
    )[0];
    expect(deleteRow.props.disabled).toBe(false);
  });

  it('cancelling the confirmation dialog performs no deletion', async () => {
    const root = await renderSettings();

    const deleteRow = root.findAll(
      (n) => n.props?.accessibilityLabel === 'Delete Account' && typeof n.props?.onPress === 'function',
    )[0];
    await act(async () => {
      deleteRow.props.onPress();
    });

    // Dialog shown, but nothing pressed — no API call, no state change.
    expect(alertSpy).toHaveBeenCalledWith(
      'Delete Account',
      expect.stringContaining('cannot be undone'),
      expect.any(Array),
    );
    expect(mockApiDelete).not.toHaveBeenCalled();
    expect(mockAuthSignOut).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reduce motion (Requirements 39–41)
// ---------------------------------------------------------------------------

describe('SettingsScreen — save-success banner respects reduce motion', () => {
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReduceMotion = false;
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockApiGet.mockResolvedValue(SETTINGS_RESPONSE);
    mockApiPatch.mockResolvedValue(SETTINGS_RESPONSE);
    signInTestUser();
  });

  afterEach(() => {
    mockReduceMotion = false;
    alertSpy.mockRestore();
  });

  /** Marks the form dirty via a toggle, then presses Save Settings. */
  async function toggleAndSave(root: ReactTestInstance) {
    const scenicSwitch = root.findAll(
      (n) => n.props?.accessibilityLabel === 'Scenic routing toggle' && typeof n.props?.onValueChange === 'function',
    )[0];
    expect(scenicSwitch).toBeDefined();
    await act(async () => {
      scenicSwitch.props.onValueChange(true);
    });
    const saveBtn = root.findAll(
      (n) => n.props?.accessibilityLabel === 'Save settings' && typeof n.props?.onPress === 'function',
    )[0];
    expect(saveBtn).toBeDefined();
    await act(async () => {
      saveBtn.props.onPress();
    });
  }

  function successBanner(root: ReactTestInstance) {
    return root.findAll((n) => {
      const children = n.props?.children;
      const text = Array.isArray(children) ? children.join('') : children;
      return typeof text === 'string' && text.trim() === 'Settings saved.';
    });
  }

  it('with reduce motion ON: the banner appears in place, with no fade animation', async () => {
    mockReduceMotion = true;
    const timingSpy = jest.spyOn(Animated, 'timing');

    const root = await renderSettings();
    timingSpy.mockClear();
    await toggleAndSave(root);

    expect(successBanner(root).length).toBeGreaterThan(0);
    // No fade-in tween for the banner — it must appear statically. The banner
    // tween is the only 200/250ms timing WITHOUT an easing (TouchableOpacity's
    // internal press animations always pass one).
    const bannerTweens = timingSpy.mock.calls.filter((c) => {
      const config = c[1] as { duration?: number; easing?: unknown };
      return config.easing === undefined && (config.duration === 200 || config.duration === 250);
    });
    expect(bannerTweens).toHaveLength(0);

    timingSpy.mockRestore();
  });

  it('with reduce motion OFF: the banner fades in (guards the spy approach above)', async () => {
    const timingSpy = jest.spyOn(Animated, 'timing');

    const root = await renderSettings();
    timingSpy.mockClear();
    await toggleAndSave(root);

    expect(successBanner(root).length).toBeGreaterThan(0);
    const fadeIn = timingSpy.mock.calls.filter((c) => {
      const config = c[1] as { toValue?: number; duration?: number; easing?: unknown };
      return config.easing === undefined && config.toValue === 1 && config.duration === 200;
    });
    expect(fadeIn.length).toBeGreaterThan(0);

    timingSpy.mockRestore();
  });
});
