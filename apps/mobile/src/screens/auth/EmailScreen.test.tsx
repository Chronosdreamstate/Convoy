/**
 * EmailScreen tests — Requirement 36.1 / Requirement 2.4 / App Store
 * Guideline 4.8: the email auth entry screen must also offer Sign in with
 * Apple on iOS (with the "or" divider) and Sign in with Google on both
 * platforms; Apple must not show on Android.
 */

import React from 'react';
import { Platform } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

const mockSignInEmail = jest.fn();
const mockSignUpEmail = jest.fn();
const mockSignInSocial = jest.fn();
const mockGetPostAuthRoute = jest.fn();
jest.mock('../../services/AuthService', () => ({
  authService: {
    signInEmail: (...args: unknown[]) => mockSignInEmail(...args),
    signUpEmail: (...args: unknown[]) => mockSignUpEmail(...args),
    signInSocial: (...args: unknown[]) => mockSignInSocial(...args),
    getPostAuthRoute: (...args: unknown[]) => mockGetPostAuthRoute(...args),
  },
}));

const mockRouterReplace = jest.fn();
const mockRouterPush = jest.fn();
const mockRouterBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockRouterReplace, push: mockRouterPush, back: mockRouterBack }),
}));

jest.mock('expo-apple-authentication', () => ({
  signInAsync: jest.fn(),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
}));

import EmailScreen from './EmailScreen';

/** Works whether Platform.OS is a data property or an object-literal getter. */
function setPlatformOS(os: 'ios' | 'android') {
  Object.defineProperty(Platform, 'OS', { get: () => os, configurable: true });
}

beforeEach(() => {
  jest.clearAllMocks();
  setPlatformOS('ios');
  mockGetPostAuthRoute.mockResolvedValue({ route: '/(tabs)/map', isFirstLogin: false });
});

afterEach(() => {
  setPlatformOS('ios');
});

describe('EmailScreen', () => {
  it('offers Sign in with Apple and Google below the email form on iOS (Req 36.1, Req 2.4)', () => {
    const screen = render(<EmailScreen />);

    // Primary email form is intact…
    expect(screen.getByLabelText('Email address, required')).toBeTruthy();
    expect(screen.getByLabelText('Password, required')).toBeTruthy();
    expect(screen.getByLabelText('Sign In')).toBeTruthy();

    // …and the alternative-auth section is present.
    expect(screen.getByText('or')).toBeTruthy();
    expect(screen.getByTestId('apple-sign-in-button')).toBeTruthy();
    expect(screen.getByText('Sign in with Apple')).toBeTruthy();
    expect(screen.getByTestId('google-sign-in-button')).toBeTruthy();
    expect(screen.getByText('Sign in with Google')).toBeTruthy();
  });

  it('offers Google but not Apple on Android', () => {
    setPlatformOS('android');
    const screen = render(<EmailScreen />);

    expect(screen.getByLabelText('Email address, required')).toBeTruthy();
    expect(screen.queryByTestId('apple-sign-in-button')).toBeNull();
    // Google is cross-platform, so the "or" divider stays on Android.
    expect(screen.getByText('or')).toBeTruthy();
    expect(screen.getByTestId('google-sign-in-button')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Post-auth routing parity (Req 36.7): the email flow must route first-time
// users into onboarding exactly like the OTP flow, instead of always jumping
// to the map.
// ---------------------------------------------------------------------------
describe('EmailScreen post-auth routing', () => {
  const AUTH_RESULT = {
    user: { id: 'u-email-1', displayName: 'Email Driver', privacy: 'open' },
    accessToken: 'token-email',
  };

  async function submitSignIn(screen: ReturnType<typeof render>) {
    fireEvent.changeText(screen.getByLabelText('Email address, required'), 'driver@example.com');
    fireEvent.changeText(screen.getByLabelText('Password, required'), 'password123');
    fireEvent.press(screen.getByLabelText('Sign In'));
  }

  it('routes a returning user to the map', async () => {
    mockSignInEmail.mockResolvedValue(AUTH_RESULT);
    const screen = render(<EmailScreen />);

    await submitSignIn(screen);

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/(tabs)/map'));
  });

  it('routes a first-time user into onboarding at the resume step', async () => {
    mockSignInEmail.mockResolvedValue(AUTH_RESULT);
    mockGetPostAuthRoute.mockResolvedValue({ route: '/(onboarding)/vehicle', isFirstLogin: true });
    const screen = render(<EmailScreen />);

    await submitSignIn(screen);

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/(onboarding)/vehicle'));
  });

  it('surfaces the server-provided error message on failure (Req 2.7)', async () => {
    mockSignInEmail.mockRejectedValue(new Error('Invalid credentials'));
    const screen = render(<EmailScreen />);

    await submitSignIn(screen);

    await waitFor(() => expect(screen.getByText('Invalid credentials')).toBeTruthy());
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });
});
