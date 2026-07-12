/**
 * OtpScreen tests:
 *  - Resend flow correctness (Req 2.7): resend is locked behind a visible
 *    cooldown, unlocks when it elapses, and confirms the new code was sent.
 *  - Verification errors surface a descriptive message (Req 2.7), with the
 *    error shake skipped under OS reduce-motion (Req 39–41).
 */

import React from 'react';
import { Animated } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue('1'),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

const mockRequestOtp = jest.fn();
const mockVerifyOtp = jest.fn();
jest.mock('../../services/AuthService', () => ({
  authService: {
    requestOtp: (...args: unknown[]) => mockRequestOtp(...args),
    verifyOtp: (...args: unknown[]) => mockVerifyOtp(...args),
  },
}));

const mockRouterReplace = jest.fn();
const mockRouterPush = jest.fn();
const mockRouterBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockRouterReplace, push: mockRouterPush, back: mockRouterBack }),
  useLocalSearchParams: () => ({ phone: '+15551234567' }),
}));

let mockReduceMotion = false;
jest.mock('../../hooks/useReduceMotion', () => ({
  useReduceMotion: () => mockReduceMotion,
}));

import OtpScreen from './OtpScreen';

beforeEach(() => {
  jest.clearAllMocks();
  mockReduceMotion = false;
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

/** Types a code into the hidden OTP input and flushes the 300ms auto-submit. */
async function enterCode(screen: ReturnType<typeof render>, code: string) {
  fireEvent.changeText(screen.getByLabelText('Verification code, 6 digits'), code);
  await act(async () => {
    jest.advanceTimersByTime(300);
  });
}

describe('OtpScreen resend flow (Req 2.7)', () => {
  it('locks resend behind the cooldown, then unlocks and confirms the new code', async () => {
    mockRequestOtp.mockResolvedValue({});
    const screen = render(<OtpScreen />);

    // Cooldown running — the resend control is disabled and shows a countdown.
    expect(screen.getByText(/Resend code in \d+s/)).toBeTruthy();

    // Let the 30s cooldown elapse.
    act(() => {
      jest.advanceTimersByTime(30_000);
    });
    const resend = screen.getByText('Resend code');

    fireEvent.press(resend);
    await waitFor(() => expect(mockRequestOtp).toHaveBeenCalledWith('+15551234567'));

    // Confirmation copy + a fresh cooldown.
    expect(screen.getByText('A new code has been sent.')).toBeTruthy();
    expect(screen.getByText(/Resend code in \d+s/)).toBeTruthy();
  });
});

describe('OtpScreen verification errors', () => {
  it('shows the service error and shakes the digit row when motion is allowed', async () => {
    mockVerifyOtp.mockRejectedValue(new Error('Invalid or expired code.'));
    const sequenceSpy = jest.spyOn(Animated, 'sequence');
    const screen = render(<OtpScreen />);

    await enterCode(screen, '123456');

    await waitFor(() => expect(screen.getByText('Invalid or expired code.')).toBeTruthy());
    expect(sequenceSpy).toHaveBeenCalled();
  });

  it('skips the error shake under OS reduce-motion but still shows the error', async () => {
    mockReduceMotion = true;
    mockVerifyOtp.mockRejectedValue(new Error('Invalid or expired code.'));
    const sequenceSpy = jest.spyOn(Animated, 'sequence');
    const screen = render(<OtpScreen />);

    await enterCode(screen, '123456');

    await waitFor(() => expect(screen.getByText('Invalid or expired code.')).toBeTruthy());
    expect(sequenceSpy).not.toHaveBeenCalled();
  });
});
