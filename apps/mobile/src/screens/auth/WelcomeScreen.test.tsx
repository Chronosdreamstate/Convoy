/**
 * WelcomeScreen tests — funnel entry points and the Google "Coming Soon"
 * fallback (Req 2). The fallback copy must only suggest Apple Sign-In on iOS;
 * Android has no Apple auth to fall back to.
 */

import React from 'react';
import { Alert, Platform } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

const mockSignInSocial = jest.fn();
jest.mock('../../services/AuthService', () => ({
  authService: {
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

// reduceMotion: true makes goToSlide snap synchronously (no Animated
// completion callbacks), so tests can step to the last slide with plain
// presses. It also exercises the reduce-motion snap path for the dots.
jest.mock('../../hooks/useAccessibilitySettings', () => ({
  useAccessibilitySettings: () => ({ reduceMotion: true, screenReaderActive: false, boldText: false }),
}));

import WelcomeScreen from './WelcomeScreen';

/** Works whether Platform.OS is a data property or an object-literal getter. */
function setPlatformOS(os: 'ios' | 'android') {
  Object.defineProperty(Platform, 'OS', { get: () => os, configurable: true });
}

/** Advances the carousel to the last slide, where the social auth lives. */
function goToLastSlide(screen: ReturnType<typeof render>) {
  fireEvent.press(screen.getByLabelText('Next slide'));
  fireEvent.press(screen.getByLabelText('Next slide'));
  fireEvent.press(screen.getByLabelText('Next slide'));
}

beforeEach(() => {
  jest.clearAllMocks();
  setPlatformOS('ios');
});

afterEach(() => {
  setPlatformOS('ios');
});

describe('WelcomeScreen', () => {
  it('offers guest map access from every slide (Req 1)', () => {
    const screen = render(<WelcomeScreen />);

    fireEvent.press(screen.getByLabelText('Continue as Guest'));
    expect(mockRouterPush).toHaveBeenCalledWith('/(tabs)/map');
  });

  it('suggests Apple Sign-In in the Google fallback on iOS', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    const screen = render(<WelcomeScreen />);
    goToLastSlide(screen);

    fireEvent.press(screen.getByLabelText('Sign in with Google'));

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const message = alertSpy.mock.calls[0][1];
    expect(message).toContain('Apple Sign-In');
  });

  it('does not suggest Apple Sign-In in the Google fallback on Android', () => {
    setPlatformOS('android');
    const alertSpy = jest.spyOn(Alert, 'alert');
    const screen = render(<WelcomeScreen />);
    goToLastSlide(screen);

    fireEvent.press(screen.getByLabelText('Sign in with Google'));

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const message = alertSpy.mock.calls[0][1];
    expect(message).not.toContain('Apple');
    expect(message).toContain('email');
  });

  it('sends returning users from the last slide to email sign-in', () => {
    const screen = render(<WelcomeScreen />);
    goToLastSlide(screen);

    fireEvent.press(screen.getByLabelText('Sign In'));
    expect(mockRouterPush).toHaveBeenCalledWith('/(auth)/email');
  });
});
