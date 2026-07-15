/**
 * Unit tests for the shared AppleSignInButton (Requirement 36.1 — Sign in
 * with Apple must be offered wherever alternative auth is offered; App Store
 * Guideline 4.8):
 *  - Renders on iOS, renders nothing on Android.
 *  - Pressing it runs the native Apple credential prompt, exchanges the
 *    identity token via authService.signInSocial('apple', ...), stores the
 *    session, and navigates to the map.
 *  - A user-cancelled prompt is silent; any other failure surfaces the
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

const mockSignInSocial = jest.fn();
const mockGetPostAuthRoute = jest.fn();
jest.mock('../services/AuthService', () => ({
  authService: {
    signInSocial: (...args: unknown[]) => mockSignInSocial(...args),
    getPostAuthRoute: (...args: unknown[]) => mockGetPostAuthRoute(...args),
  },
}));

const mockRouterReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockRouterReplace }),
}));

const mockAppleSignInAsync = jest.fn();
jest.mock('expo-apple-authentication', () => ({
  signInAsync: (...args: unknown[]) => mockAppleSignInAsync(...args),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
}));

import AppleSignInButton from './AppleSignInButton';
import { useAuthStore } from '../stores/authStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Works whether Platform.OS is a data property or an object-literal getter. */
function setPlatformOS(os: 'ios' | 'android') {
  Object.defineProperty(Platform, 'OS', { get: () => os, configurable: true });
}

const TEST_USER = { id: 'u-apple-1', displayName: 'Apple Driver', privacy: 'open' };

beforeEach(() => {
  jest.clearAllMocks();
  setPlatformOS('ios');
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
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AppleSignInButton', () => {
  it('renders the Sign in with Apple button on iOS', () => {
    const screen = render(<AppleSignInButton />);
    expect(screen.getByTestId('apple-sign-in-button')).toBeTruthy();
    expect(screen.getByText('Sign in with Apple')).toBeTruthy();
  });

  it('renders nothing on Android', () => {
    setPlatformOS('android');
    const screen = render(<AppleSignInButton />);
    expect(screen.queryByTestId('apple-sign-in-button')).toBeNull();
  });

  it('signs in via authService, stores the session, and navigates to the map on press', async () => {
    mockAppleSignInAsync.mockResolvedValue({ identityToken: 'apple-id-token' });
    mockSignInSocial.mockResolvedValue({ user: TEST_USER, accessToken: 'jwt-123' });
    const onLoadingChange = jest.fn();

    const screen = render(<AppleSignInButton onLoadingChange={onLoadingChange} />);
    fireEvent.press(screen.getByTestId('apple-sign-in-button'));

    await waitFor(() => {
      expect(mockRouterReplace).toHaveBeenCalledWith('/(tabs)/map');
    });
    expect(mockAppleSignInAsync).toHaveBeenCalledWith({ requestedScopes: [0, 1] });
    expect(mockSignInSocial).toHaveBeenCalledWith('apple', 'apple-id-token');
    expect(useAuthStore.getState().user).toEqual(TEST_USER);
    expect(useAuthStore.getState().accessToken).toBe('jwt-123');
    // Loading state was reported both on entry and on completion.
    expect(onLoadingChange).toHaveBeenCalledWith(true);
    expect(onLoadingChange).toHaveBeenLastCalledWith(false);
  });

  it('does not call the auth service when Apple returns no identity token', async () => {
    mockAppleSignInAsync.mockResolvedValue({ identityToken: null });

    const screen = render(<AppleSignInButton />);
    fireEvent.press(screen.getByTestId('apple-sign-in-button'));

    await waitFor(() => {
      expect(mockAppleSignInAsync).toHaveBeenCalled();
    });
    expect(mockSignInSocial).not.toHaveBeenCalled();
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it('stays silent when the user cancels the Apple prompt', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockAppleSignInAsync.mockRejectedValue({ code: 'ERR_REQUEST_CANCELED' });

    const screen = render(<AppleSignInButton />);
    fireEvent.press(screen.getByTestId('apple-sign-in-button'));

    await waitFor(() => {
      expect(mockAppleSignInAsync).toHaveBeenCalled();
    });
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  it('shows the Sign In Failed alert and re-enables the button when sign-in fails', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockAppleSignInAsync.mockResolvedValue({ identityToken: 'apple-id-token' });
    mockSignInSocial.mockRejectedValue(new Error('server exploded'));

    const screen = render(<AppleSignInButton />);
    fireEvent.press(screen.getByTestId('apple-sign-in-button'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        'Sign In Failed',
        'Could not sign in with Apple. Please try another method.',
      );
    });
    expect(mockRouterReplace).not.toHaveBeenCalled();
    expect(useAuthStore.getState().user).toBeNull();
    // Button recovers: no longer disabled/busy after the failure.
    await waitFor(() => {
      const button = screen.getByTestId('apple-sign-in-button');
      expect(button.props.accessibilityState).toEqual({ disabled: false, busy: false });
    });
  });

  it('routes a first-time user into onboarding instead of the map (Req 36.7)', async () => {
    mockAppleSignInAsync.mockResolvedValue({ identityToken: 'apple-id-token' });
    mockSignInSocial.mockResolvedValue({ user: TEST_USER, accessToken: 'jwt-123' });
    mockGetPostAuthRoute.mockResolvedValue({ route: '/(onboarding)/vehicle', isFirstLogin: true });

    const screen = render(<AppleSignInButton />);
    fireEvent.press(screen.getByTestId('apple-sign-in-button'));

    await waitFor(() => {
      expect(mockRouterReplace).toHaveBeenCalledWith('/(onboarding)/vehicle');
    });
    expect(useAuthStore.getState().isFirstLogin).toBe(true);
  });

  it('surfaces the server-provided error message when the API explains the failure', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockAppleSignInAsync.mockResolvedValue({ identityToken: 'apple-id-token' });
    // AuthService throws ApiError (Error + numeric status) with the server's message.
    const apiError = Object.assign(new Error('Too many sign-in attempts. Please try again later.'), {
      status: 429,
    });
    mockSignInSocial.mockRejectedValue(apiError);

    const screen = render(<AppleSignInButton />);
    fireEvent.press(screen.getByTestId('apple-sign-in-button'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        'Sign In Failed',
        'Too many sign-in attempts. Please try again later.',
      );
    });
  });

  it('respects an external disabled flag', () => {
    const screen = render(<AppleSignInButton disabled />);
    fireEvent.press(screen.getByTestId('apple-sign-in-button'));
    expect(mockAppleSignInAsync).not.toHaveBeenCalled();
  });
});
