import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, DimensionValue, StyleSheet, View } from 'react-native';
import { ThemeColors, useTheme } from '../theme';
import { useReduceMotion } from '../hooks/useReduceMotion';

function useShimmer() {
  const opacity = useRef(new Animated.Value(0.3)).current;
  const reduceMotion = useReduceMotion();

  useEffect(() => {
    if (reduceMotion) {
      // Static placeholder — hold a fixed mid-opacity instead of shimmering.
      opacity.setValue(0.5);
      return;
    }
    opacity.setValue(0.3);
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [opacity, reduceMotion]);

  return opacity;
}

// ---------------------------------------------------------------------------
// SkeletonBox — a single rectangle placeholder
// ---------------------------------------------------------------------------

interface SkeletonBoxProps {
  width?: DimensionValue;
  height?: number;
  borderRadius?: number;
}

export function SkeletonBox({ width = '100%', height = 16, borderRadius = 4 }: SkeletonBoxProps) {
  const { colors } = useTheme();
  const opacity = useShimmer();
  return (
    <Animated.View
      style={[{ backgroundColor: colors.border }, { width, height, borderRadius, opacity }]}
    />
  );
}

// ---------------------------------------------------------------------------
// SkeletonRow — circle avatar + two lines
// ---------------------------------------------------------------------------

export function SkeletonRow() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const opacity = useShimmer();
  return (
    <Animated.View style={[styles.row, { opacity }]}>
      <View style={styles.circle} />
      <View style={styles.lines}>
        <View style={[styles.box, { width: '60%', height: 14, borderRadius: 4, marginBottom: 6 }]} />
        <View style={[styles.box, { width: '40%', height: 11, borderRadius: 4 }]} />
      </View>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// SkeletonCard — full card with header row + 3 body lines (default export)
// ---------------------------------------------------------------------------

export default function SkeletonCard() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const opacity = useShimmer();
  return (
    <Animated.View style={[styles.card, { opacity }]}>
      {/* Header row */}
      <View style={styles.row}>
        <View style={styles.circle} />
        <View style={styles.lines}>
          <View style={[styles.box, { width: '55%', height: 14, borderRadius: 4, marginBottom: 6 }]} />
          <View style={[styles.box, { width: '35%', height: 11, borderRadius: 4 }]} />
        </View>
      </View>
      {/* Body lines */}
      <View style={styles.body}>
        <View style={[styles.box, { width: '100%', height: 12, borderRadius: 4, marginBottom: 8 }]} />
        <View style={[styles.box, { width: '85%', height: 12, borderRadius: 4, marginBottom: 8 }]} />
        <View style={[styles.box, { width: '65%', height: 12, borderRadius: 4 }]} />
      </View>
    </Animated.View>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    box: {
      backgroundColor: colors.border,
    },
    circle: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.border,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    lines: {
      flex: 1,
      justifyContent: 'center',
    },
    card: {
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 16,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: colors.border,
    },
    body: {
      marginTop: 16,
    },
  });
}
