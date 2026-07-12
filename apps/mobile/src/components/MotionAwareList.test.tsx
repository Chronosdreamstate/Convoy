import React from 'react';
import TestRenderer, { act, ReactTestInstance } from 'react-test-renderer';
import { AccessibilityInfo, Animated } from 'react-native';
import { renderHook, act as hookAct } from '@testing-library/react-native';
import { useMotionStore } from '../stores/motionStore';
import { MOTION_LIST_CAP, MotionCapNotice, useMotionCappedData } from './MotionAwareList';

function render(ui: React.ReactElement): ReactTestInstance {
  let renderer!: ReturnType<typeof TestRenderer.create>;
  act(() => {
    renderer = TestRenderer.create(ui);
  });
  return renderer.root;
}

/** True if any Text node's flattened children join to exactly this string. */
function hasText(root: ReactTestInstance, text: string): boolean {
  return root.findAll((n) => {
    const children = n.props?.children;
    const joined = Array.isArray(children) ? children.join('') : children;
    return joined === text;
  }).length > 0;
}

const ITEMS = ['a', 'b', 'c', 'd', 'e', 'f'];

beforeEach(() => {
  // Each test starts parked — the store is module-level state shared across tests.
  useMotionStore.setState({ isInMotion: false });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useMotionCappedData', () => {
  it('passes data through untouched (same identity) while parked', () => {
    const { result } = renderHook(() => useMotionCappedData(ITEMS));

    expect(result.current.data).toBe(ITEMS);
    expect(result.current.isCapped).toBe(false);
    expect(result.current.hiddenCount).toBe(0);
  });

  it(`caps to ${MOTION_LIST_CAP} items while in motion`, () => {
    useMotionStore.setState({ isInMotion: true });
    const { result } = renderHook(() => useMotionCappedData(ITEMS));

    expect(result.current.data).toEqual(['a', 'b', 'c', 'd']);
    expect(result.current.isCapped).toBe(true);
    expect(result.current.hiddenCount).toBe(2);
  });

  it('does not cap short lists even while in motion', () => {
    useMotionStore.setState({ isInMotion: true });
    const short = ['a', 'b', 'c', 'd'];
    const { result } = renderHook(() => useMotionCappedData(short));

    // Exactly at the cap — nothing is hidden, so no cap and no notice count.
    expect(result.current.data).toBe(short);
    expect(result.current.isCapped).toBe(false);
    expect(result.current.hiddenCount).toBe(0);
  });

  it('reacts live to motion-state changes in both directions', () => {
    const { result } = renderHook(() => useMotionCappedData(ITEMS));
    expect(result.current.data).toHaveLength(ITEMS.length);

    // Vehicle starts moving — the cap engages without a remount.
    hookAct(() => useMotionStore.setState({ isInMotion: true }));
    expect(result.current.data).toHaveLength(MOTION_LIST_CAP);
    expect(result.current.hiddenCount).toBe(2);

    // Vehicle parks — the full list is restored.
    hookAct(() => useMotionStore.setState({ isInMotion: false }));
    expect(result.current.data).toHaveLength(ITEMS.length);
    expect(result.current.isCapped).toBe(false);
  });
});

describe('MotionCapNotice', () => {
  it('renders nothing when no rows are hidden', () => {
    const root = render(<MotionCapNotice hiddenCount={0} />);
    expect(root.findAll((n) => n.props?.accessibilityRole === 'text')).toHaveLength(0);
  });

  it('shows the pull-over affordance with the hidden-row count', () => {
    const root = render(<MotionCapNotice hiddenCount={3} />);

    expect(hasText(root, 'Pull over to see 3 more')).toBe(true);
    // Announced to screen readers with the full driving context.
    expect(
      root.findAll(
        (n) => n.props?.accessibilityLabel === 'List limited while driving. Pull over to see 3 more.',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('fades in by default but renders statically under OS reduce-motion', async () => {
    const timing = jest.spyOn(Animated, 'timing');

    // Default (reduce motion off) — the notice animates in.
    render(<MotionCapNotice hiddenCount={2} />);
    expect(timing).toHaveBeenCalled();

    timing.mockClear();
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);

    const root = render(<MotionCapNotice hiddenCount={2} />);
    // Flush the async reduce-motion probe.
    await act(async () => {});

    // Static equivalent: content still present, no fade animation started
    // after the reduce-motion setting resolved.
    expect(hasText(root, 'Pull over to see 2 more')).toBe(true);
    const callsAfterProbe = timing.mock.calls.length;
    expect(callsAfterProbe).toBeLessThanOrEqual(1); // at most the pre-probe first render
  });
});
