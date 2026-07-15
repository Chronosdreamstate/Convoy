/**
 * Unit tests for the shared GoogleSignInButton (Requirement 2.4 — Sign in
 * with Google, offered wherever alternative auth is offered for Guideline
 * 4.8 parity with the Apple button):
 *  - Config-gated: without a platform OAuth client ID the button renders but
 *    degrades to the platform-aware "Coming Soon" alert (previous behaviour).
 *  - When configured, pressing it runs the expo-auth-session browser prompt,
 *    exchanges the ID token via authService.signInWithGoogle(...), stores
 *    the session, and navigates to the map.
 *  - A user-dismissed prompt is silent; any other failure surfaces the
 *    "Sign In Failed" alert and re-enables the button.
 */

import React from 'react';
import { Alert, Platform } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

const mockSignInWithGoogle = jest.fn();
const mockGetPostAuthRoute = jest.fn();
jest.mock('../services/AuthService', () => ({
  authService: {
    signInWithGoogle: (...args: unknown[]) => mockSignInWithGoogle(...args),
    getPostAuthRoute: (...args: unknown[]) => mockGetPostAuthRoute(...args),
  },
}));

const mockRouterReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockRouterReplace }),
}));

const mockPromptAsync = jest.fn();
let mockRequest: object | null = {};
const mockUseIdTokenAuthRequest = jest.fn((..._args: unknown[]) => [mockRequest, null, mockPromptAsync]);
jest.mock('expo-auth-session/providers/google', () => ({
  useIdTokenAuthRequest: (...args: unknown[]) => mockUseIdTokenAuthRequest(...args),
}));

import GoogleSignInButton from './GoogleSignInButton';
import { useAuthStore } from '../stores/authStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Works whether Platform.OS is a data property or an object-literal getter. */
function setPlatformOS(os: 'ios' | 'android') {
  Object.defineProperty(Platform, 'OS', { get: () => os, configurable: true });
}

const IOS_CLIENT_ID = 'ios-client.apps.googleusercontent.com';
const ANDROID_CLIENT_ID = 'android-client.apps.googleusercontent.com';
const WEB_CLIENT_ID = 'web-client.apps.googleusercontent.com';

/** Makes the button take the live sign-in path for the current platform. */
function configureGoogleEnv() {
  process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = IOS_CLIENT_ID;
  process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID = ANDROID_CLIENT_ID;
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = WEB_CLIENT_ID;
}

function clearGoogleEnv() {
  delete process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  delete process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID;
  delete process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
}

const TEST_USER = { id: 'u-google-1', displayName: 'Google Driver', privacy: 'open' };

beforeEach(() => {
  jest.clearAllMocks();
  setPlatformOS('ios');
  clearGoogleEnv();
  mockRequest = {};
  mockGetPostAuthRoute.mockResolvedValue({ route: '/(tabs)/map', isFirstLogin: false });
  useAuthStore.setState({
    user: null,
    accessToken: null,
    token: null,
    isAuthenticated: false,
  });
});

afterEach(() => {
  setPlatformOS('ios');
  clearGoogleEnv();
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GoogleSignInButton — unconfigured (Coming Soon fallback)', () => {
  it('renders the button on iOS without loading the auth-session hook', () => {
    const screen = render(<GoogleSignInButton />);
    expect(screen.getByTestId('google-sign-in-button')).toBeTruthy();
    expect(screen.getByText('Sign in with Google')).toBeTruthy();
    expect(mockUseIdTokenAuthRequest).not.toHaveBeenCalled();
  });

  it('renders the button on Android too (unlike the Apple button)', () => {
    setPlatformOS('android');
    const screen = render(<GoogleSignInButton />);
    expect(screen.getByTestId('google-sign-in-button')).toBeTruthy();
  });

  it('suggests Apple Sign-In in the fallback alert on iOS', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const screen = render(<GoogleSignInButton />);

    fireEvent.press(screen.getByTestId('google-sign-in-button'));

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toBe('Coming Soon');
    expect(alertSpy.mock.calls[0][1]).toContain('Apple Sign-In');
    expect(mockSignInWithGoogle).not.toHaveBeenCalled();
  });

  it('does not suggest Apple Sign-In in the fallback alert on Android', () => {
    setPlatformOS('android');
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const screen = render(<GoogleSignInButton />);

    fireEvent.press(screen.getByTestId('google-sign-in-button'));

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const message = alertSpy.mock.calls[0][1];
    expect(message).not.toContain('Apple');
    expect(message).toContain('email');
  });

  it('falls back on Android when only the iOS client ID is configured', () => {
    setPlatformOS('android');
    process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = IOS_CLIENT_ID;
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const screen = render(<GoogleSignInButton />);

    fireEvent.press(screen.getByTestId('google-sign-in-button'));

    expect(alertSpy).toHaveBeenCalledWith('Coming Soon', expect.any(String));
    expect(mockUseIdTokenAuthRequest).not.toHaveBeenCalled();
  });
});

describe('GoogleSignInButton — configured (live flow)', () => {
  beforeEach(() => {
    configureGoogleEnv();
  });

  it('passes the configured client IDs to the auth request hook', () => {
    render(<GoogleSignInButton />);

    expect(mockUseIdTokenAuthRequest).toHaveBeenCalledWith({
      iosClientId: IOS_CLIENT_ID,
      androidClientId: ANDROID_CLIENT_ID,
      webClientId: WEB_CLIENT_ID,
    });
  });

  it('signs in via authService, stores the session, and navigates to the map on success', async () => {
    mockPromptAsync.mockResolvedValue({ type: 'success', params: { id_token: 'google-id-token' } });
    mockSignInWithGoogle.mockResolvedValue({ user: TEST_USER, accessToken: 'jwt-456' });
    const onLoadingChange = jest.fn();

    const screen = render(<GoogleSignInButton onLoadingChange={onLoadingChange} />);
    fireEvent.press(screen.getByTestId('google-sign-in-button'));

    await waitFor(() => {
      expect(mockRouterReplace).toHaveBeenCalledWith('/(tabs)/map');
    });
    expect(mockSignInWithGoogle).toHaveBeenCalledWith('google-id-token');
    expect(useAuthStore.getState().user).toEqual(TEST_USER);
    expect(useAuthStore.getState().accessToken).toBe('jwt-456');
    // Loading state was reported both on entry and on completion.
    expect(onLoadingChange).toHaveBeenCalledWith(true);
    expect(onLoadingChange).toHaveBeenLastCalledWith(false);
  });

  it('shows the failure alert (not silence) when a success response has no id_token', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockPromptAsync.mockResolvedValue({ type: 'success', params: {} });

    const screen = render(<GoogleSignInButton />);
    fireEvent.press(screen.getByTestId('google-sign-in-button'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        'Sign In Failed',
        'Could not sign in with Google. Please try another method.',
      );
    });
    expect(mockSignInWithGoogle).not.toHaveBeenCalled();
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it('routes a first-time user into onboarding instead of the map (Req 36.7)', async () => {
    mockPromptAsync.mockResolvedValue({ type: 'success', params: { id_token: 'google-id-token' } });
    mockSignInWithGoogle.mockResolvedValue({ user: TEST_USER, accessToken: 'jwt-456' });
    mockGetPostAuthRoute.mockResolvedValue({ route: '/(onboarding)/vehicle', isFirstLogin: true });

    const screen = render(<GoogleSignInButton />);
    fireEvent.press(screen.getByTestId('google-sign-in-button'));

    await waitFor(() => {
      expect(mockRouterReplace).toHaveBeenCalledWith('/(onboarding)/vehicle');
    });
    expect(useAuthStore.getState().isFirstLogin).toBe(true);
  });

  it('surfaces the server-provided error message when the API explains the failure', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockPromptAsync.mockResolvedValue({ type: 'success', params: { id_token: 'google-id-token' } });
    // AuthService throws ApiError (Error + numeric status) with the server's
    // message — e.g. the 503 PROVIDER_NOT_CONFIGURED gate.
    const apiError = Object.assign(new Error('Google sign-in is not available on this server.'), {
      status: 503,
    });
    mockSignInWithGoogle.mockRejectedValue(apiError);

    const screen = render(<GoogleSignInButton />);
    fireEvent.press(screen.getByTestId('google-sign-in-button'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        'Sign In Failed',
        'Google sign-in is not available on this server.',
      );
    });
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'dismiss'] as const)(
    'stays silent when the user backs out of the prompt (%s)',
    async (type) => {
      const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      mockPromptAsync.mockResolvedValue({ type });

      const screen = render(<GoogleSignInButton />);
      fireEvent.press(screen.getByTestId('google-sign-in-button'));

      await waitFor(() => {
        expect(mockPromptAsync).toHaveBeenCalled();
      });
      expect(alertSpy).not.toHaveBeenCalled();
      expect(mockRouterReplace).not.toHaveBeenCalled();
    },
  );

  it('shows the Sign In Failed alert when the prompt reports an error', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockPromptAsync.mockResolvedValue({ type: 'error', params: {} });

    const screen = render(<GoogleSignInButton />);
    fireEvent.press(screen.getByTestId('google-sign-in-button'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        'Sign In Failed',
        'Could not sign in with Google. Please try another method.',
      );
    });
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it('shows the Sign In Failed alert and re-enables the button when the exchange fails', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockPromptAsync.mockResolvedValue({ type: 'success', params: { id_token: 'google-id-token' } });
    mockSignInWithGoogle.mockRejectedValue(new Error('server exploded'));

    const screen = render(<GoogleSignInButton />);
    fireEvent.press(screen.getByTestId('google-sign-in-button'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        'Sign In Failed',
        'Could not sign in with Google. Please try another method.',
      );
    });
    expect(mockRouterReplace).not.toHaveBeenCalled();
    expect(useAuthStore.getState().user).toBeNull();
    // Button recovers: no longer disabled/busy after the failure.
    await waitFor(() => {
      const button = screen.getByTestId('google-sign-in-button');
      expect(button.props.accessibilityState).toEqual({ disabled: false, busy: false });
    });
  });

  it('respects an external disabled flag', () => {
    const screen = render(<GoogleSignInButton disabled />);
    fireEvent.press(screen.getByTestId('google-sign-in-button'));
    expect(mockPromptAsync).not.toHaveBeenCalled();
  });

  it('does not prompt before the auth request has loaded', () => {
    mockRequest = null;
    const screen = render(<GoogleSignInButton />);
    fireEvent.press(screen.getByTestId('google-sign-in-button'));
    expect(mockPromptAsync).not.toHaveBeenCalled();
  });
});
