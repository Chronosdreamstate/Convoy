import { AccessibilityInfo } from 'react-native';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useReduceMotion } from './useReduceMotion';

type MotionHandler = (enabled: boolean) => void;

function mockAccessibilityInfo(opts: {
  reduceMotionEnabled?: boolean;
  rejectProbe?: boolean;
}) {
  const remove = jest.fn();
  let motionHandler: MotionHandler | null = null;

  const probe = jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled');
  if (opts.rejectProbe) {
    probe.mockRejectedValue(new Error('not supported'));
  } else {
    probe.mockResolvedValue(opts.reduceMotionEnabled ?? false);
  }

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

describe('useReduceMotion', () => {
  it('defaults to false before the OS probe resolves', () => {
    mockAccessibilityInfo({ reduceMotionEnabled: true });
    const { result } = renderHook(() => useReduceMotion());
    expect(result.current).toBe(false);
  });

  it('reflects the OS setting once the probe resolves', async () => {
    mockAccessibilityInfo({ reduceMotionEnabled: true });
    const { result } = renderHook(() => useReduceMotion());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('stays false (sane default) when the probe rejects', async () => {
    mockAccessibilityInfo({ rejectProbe: true });
    const { result } = renderHook(() => useReduceMotion());
    // Flush the rejected promise; the hook must swallow it and keep `false`.
    await act(async () => {});
    expect(result.current).toBe(false);
  });

  it('tracks reduceMotionChanged events', async () => {
    const { getMotionHandler } = mockAccessibilityInfo({ reduceMotionEnabled: false });
    const { result } = renderHook(() => useReduceMotion());

    await act(async () => {});
    const handler = getMotionHandler();
    expect(handler).not.toBeNull();

    act(() => handler!(true));
    expect(result.current).toBe(true);

    act(() => handler!(false));
    expect(result.current).toBe(false);
  });

  it('removes the event subscription on unmount', async () => {
    const { remove } = mockAccessibilityInfo({ reduceMotionEnabled: false });
    const { unmount } = renderHook(() => useReduceMotion());
    await act(async () => {});

    unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('ignores a probe that resolves after unmount', async () => {
    let resolveProbe!: (v: boolean) => void;
    jest
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockImplementation(() => new Promise<boolean>((res) => { resolveProbe = res; }));
    jest
      .spyOn(AccessibilityInfo, 'addEventListener')
      .mockReturnValue({ remove: jest.fn() } as unknown as ReturnType<typeof AccessibilityInfo.addEventListener>);

    const { result, unmount } = renderHook(() => useReduceMotion());
    unmount();

    // Resolving late must not attempt a state update on the unmounted hook.
    await act(async () => { resolveProbe(true); });
    expect(result.current).toBe(false);
  });
});
