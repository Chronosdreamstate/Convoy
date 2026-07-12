/**
 * PhoneScreen tests — Requirement 36.1 / App Store Guideline 4.8: the phone
 * auth entry screen must also offer Sign in with Apple on iOS (with the "or"
 * divider), and must not show it on Android.
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

const mockRequestOtp = jest.fn();
const mockSignInSocial = jest.fn();
jest.mock('../../services/AuthService', () => ({
  authService: {
    requestOtp: (...args: unknown[]) => mockRequestOtp(...args),
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

import PhoneScreen from './PhoneScreen';

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

describe('PhoneScreen', () => {
  it('offers Sign in with Apple below the phone form on iOS (Req 36.1)', () => {
    const screen = render(<PhoneScreen />);

    // Primary phone form is intact…
    expect(screen.getByLabelText('Phone number, required')).toBeTruthy();
    expect(screen.getByLabelText('Continue')).toBeTruthy();

    // …and the alternative-auth section is present.
    expect(screen.getByText('or')).toBeTruthy();
    expect(screen.getByTestId('apple-sign-in-button')).toBeTruthy();
    expect(screen.getByText('Sign in with Apple')).toBeTruthy();
  });

  it('does not offer Sign in with Apple on Android', () => {
    setPlatformOS('android');
    const screen = render(<PhoneScreen />);

    expect(screen.getByLabelText('Phone number, required')).toBeTruthy();
    expect(screen.queryByTestId('apple-sign-in-button')).toBeNull();
    expect(screen.queryByText('or')).toBeNull();
  });
});
