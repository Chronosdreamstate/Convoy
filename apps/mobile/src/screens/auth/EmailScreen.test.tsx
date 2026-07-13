/**
 * EmailScreen tests — Requirement 36.1 / Requirement 2.4 / App Store
 * Guideline 4.8: the email auth entry screen must also offer Sign in with
 * Apple on iOS (with the "or" divider) and Sign in with Google on both
 * platforms; Apple must not show on Android.
 */

import React from 'react';
import { Platform } from 'react-native';
import { render } from '@testing-library/react-native';

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
jest.mock('../../services/AuthService', () => ({
  authService: {
    signInEmail: (...args: unknown[]) => mockSignInEmail(...args),
    signUpEmail: (...args: unknown[]) => mockSignUpEmail(...args),
    signInSocial: (...args: unknown[]) => mockSignInSocial(...args),
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
