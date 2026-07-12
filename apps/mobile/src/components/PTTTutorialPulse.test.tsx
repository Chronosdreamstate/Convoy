import React from 'react';
import { AccessibilityInfo } from 'react-native';
import { render, waitFor } from '@testing-library/react-native';
import PTTTutorialPulse from './PTTTutorialPulse';

type MotionHandler = (enabled: boolean) => void;

function mockAccessibilityInfo(reduceMotionEnabled: boolean) {
  const remove = jest.fn();
  let motionHandler: MotionHandler | null = null;

  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(reduceMotionEnabled);
  jest
    .spyOn(AccessibilityInfo, 'addEventListener')
    .mockImplementation((event: string, handler: unknown) => {
      if (event === 'reduceMotionChanged') motionHandler = handler as MotionHandler;
      return { remove } as unknown as ReturnType<typeof AccessibilityInfo.addEventListener>;
    });

  return { remove, getMotionHandler: () => motionHandler };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('PTTTutorialPulse', () => {
  it('renders the animated pulse ring when reduce motion is off', async () => {
    mockAccessibilityInfo(false);

    const screen = render(<PTTTutorialPulse />);

    // The async probe resolves false — the looping Animated ring stays mounted.
    await waitFor(() => {
      expect(screen.getByTestId('ptt-tutorial-ring-animated')).toBeTruthy();
    });
    expect(screen.queryByTestId('ptt-tutorial-ring-static')).toBeNull();
  });

  it('renders a static ring (no looping pulse) when reduce motion is on', async () => {
    mockAccessibilityInfo(true);

    const screen = render(<PTTTutorialPulse />);

    await waitFor(() => {
      expect(screen.getByTestId('ptt-tutorial-ring-static')).toBeTruthy();
    });
    expect(screen.queryByTestId('ptt-tutorial-ring-animated')).toBeNull();
  });

  it('swaps to the static ring live when the OS setting changes', async () => {
    const { getMotionHandler } = mockAccessibilityInfo(false);

    const screen = render(<PTTTutorialPulse />);
    await waitFor(() => {
      expect(screen.getByTestId('ptt-tutorial-ring-animated')).toBeTruthy();
    });

    const handler = getMotionHandler();
    expect(handler).not.toBeNull();
    handler!(true);

    await waitFor(() => {
      expect(screen.getByTestId('ptt-tutorial-ring-static')).toBeTruthy();
    });
    expect(screen.queryByTestId('ptt-tutorial-ring-animated')).toBeNull();
  });
});
