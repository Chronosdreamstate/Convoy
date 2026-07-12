/**
 * MotionAwareList — Req 33 (Driver Distraction: Scrollable List Limit).
 *
 * WHILE Motion_State is "in motion", any scrollable list on the phone screen
 * must show at most 4 items without requiring scrolling. This file is the one
 * shared implementation of that rule:
 *
 *   - `useMotionCappedData(items)` caps a list's data to MOTION_LIST_CAP rows
 *     while the vehicle is in motion, and passes it through untouched (same
 *     array identity) when parked — so screens that can't appear during
 *     driving pay nothing and stationary users see the full list.
 *   - `<MotionCapNotice hiddenCount={…} />` is the affordance that tells the
 *     driver more items exist ("Pull over to see N more"). Render it as the
 *     list's ListFooterComponent; it renders nothing when the cap is off.
 *
 * Backed by `useMotionStore().isInMotion`, which is fed by `MotionStateService`
 * using hysteresis — NOT a raw speed threshold. Do not reimplement that check
 * here; always read it from the shared store so every capped list agrees on
 * the same in-motion state (same rule as useMotionGuard for Req 34).
 *
 * Usage:
 *   const { data: visibleRows, isCapped, hiddenCount } = useMotionCappedData(rows);
 *   <FlatList
 *     data={visibleRows}
 *     ListFooterComponent={<MotionCapNotice hiddenCount={hiddenCount} />}
 *     ...
 *   />
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useMotionStore } from '../stores/motionStore';
import { useReduceMotion } from '../hooks/useReduceMotion';
import { ThemeColors, useTheme, withAlpha } from '../theme';

/** Driver Distraction — Scrollable List Limit (Req 33.1): 4 rows while in motion. */
export const MOTION_LIST_CAP = 4;

// ---------------------------------------------------------------------------
// useMotionCappedData
// ---------------------------------------------------------------------------

export interface MotionCappedData<T> {
  /** The rows to render — capped to MOTION_LIST_CAP while in motion. */
  data: T[];
  /** True when rows are currently being hidden by the in-motion cap. */
  isCapped: boolean;
  /** How many rows the cap is hiding right now (0 when not capped). */
  hiddenCount: number;
}

/**
 * Caps `items` to MOTION_LIST_CAP while the vehicle is in motion. Reacts live
 * to motion-state changes via the shared motion store: the moment the vehicle
 * parks (hysteresis-debounced by MotionStateService) the full list comes back.
 *
 * When not capped, the input array is returned as-is — identity is preserved
 * so memoized inputs don't cause spurious FlatList re-renders.
 */
export function useMotionCappedData<T>(items: T[]): MotionCappedData<T> {
  const isInMotion = useMotionStore((s) => s.isInMotion);
  const isCapped = isInMotion && items.length > MOTION_LIST_CAP;

  const data = useMemo(
    () => (isCapped ? items.slice(0, MOTION_LIST_CAP) : items),
    [items, isCapped],
  );

  return {
    data,
    isCapped,
    hiddenCount: isCapped ? items.length - MOTION_LIST_CAP : 0,
  };
}

// ---------------------------------------------------------------------------
// MotionCapNotice
// ---------------------------------------------------------------------------

interface NoticeProps {
  /** `hiddenCount` from useMotionCappedData. Renders nothing when 0. */
  hiddenCount: number;
}

/**
 * The "more items exist" affordance shown under a capped list. Fades in when
 * the cap engages; renders at full opacity immediately when the OS
 * reduce-motion setting is on.
 */
export function MotionCapNotice({ hiddenCount }: NoticeProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const reduceMotion = useReduceMotion();
  const opacity = useRef(new Animated.Value(0)).current;
  const visible = hiddenCount > 0;

  useEffect(() => {
    if (!visible) {
      // Reset so the next time the cap engages, the notice fades in again
      // rather than popping in at a stale full opacity.
      opacity.setValue(0);
      return;
    }
    if (reduceMotion) {
      // Static equivalent — no fade when the OS asks for reduced motion.
      opacity.setValue(1);
      return;
    }
    Animated.timing(opacity, { toValue: 1, duration: 250, useNativeDriver: true }).start();
  }, [visible, reduceMotion, opacity]);

  if (!visible) return null;

  return (
    <Animated.View
      style={[styles.notice, { opacity }]}
      accessible={true}
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`List limited while driving. Pull over to see ${hiddenCount} more.`}
    >
      <Ionicons name="car-outline" size={14} color={colors.warning} accessible={false} />
      <Text style={styles.noticeText}>
        Pull over to see {hiddenCount} more
      </Text>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    notice: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      backgroundColor: withAlpha(colors.warning, 0.1),
      borderWidth: 1,
      borderColor: withAlpha(colors.warning, 0.35),
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 14,
      marginTop: 4,
      marginBottom: 8,
    },
    noticeText: {
      color: colors.textMuted,
      fontSize: 12,
      fontWeight: '600',
    },
  });
}
