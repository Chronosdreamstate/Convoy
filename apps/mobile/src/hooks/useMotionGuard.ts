// ─── useMotionGuard ───────────────────────────────────────────────────────────
// Req 34 — Driver Distraction: block multi-step flows while the vehicle is
// in motion (e.g. group creation wizard, add-waypoint form, add-vehicle form).
//
// Backed by `useMotionStore().isInMotion`, which is fed by `MotionStateService`
// using hysteresis — NOT a raw speed threshold. Do not reimplement that check
// here; always read it from the shared store so every gated entry point
// agrees on the same in-motion state.

import { useCallback } from 'react';
import { Alert } from 'react-native';
import { useMotionStore } from '../stores/motionStore';

/**
 * Returns a `guardInMotion()` function. Call it right before opening a
 * multi-step flow that should be blocked while driving:
 *
 *   const guardInMotion = useMotionGuard();
 *   onPress={() => { if (!guardInMotion()) openTheFlow(); }}
 *
 * When in motion, shows the "Park to continue" alert and returns `true`
 * (caller should bail out). When not in motion, returns `false` and the
 * caller should proceed as normal.
 */
export function useMotionGuard(): () => boolean {
  const isInMotion = useMotionStore((s) => s.isInMotion);

  return useCallback((): boolean => {
    if (!isInMotion) return false;
    Alert.alert('Park to continue', 'Please park before making group settings changes.');
    return true;
  }, [isInMotion]);
}
