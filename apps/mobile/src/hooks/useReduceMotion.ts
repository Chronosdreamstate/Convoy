import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * useReduceMotion — tracks the OS "reduce motion" accessibility setting.
 * Requirements: 39–41 (accessibility).
 *
 * Defaults to `false` (motion allowed) until the async probe resolves, then
 * stays in sync via the `reduceMotionChanged` event. Components with looping /
 * attention animations (pulses, shimmer, bouncing indicators) should render a
 * static equivalent when this returns `true`.
 */
export function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;

    // .catch: the probe can reject on platforms lacking the capability — an
    // accessibility check failure must never surface as an unhandled rejection.
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (mounted) setReduceMotion(enabled);
      })
      .catch(() => {});

    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);

    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  return reduceMotion;
}
