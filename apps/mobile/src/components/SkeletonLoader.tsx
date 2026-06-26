import React, { useEffect, useRef } from 'react';
import { Animated, DimensionValue, StyleSheet, View } from 'react-native';

const SKELETON_COLOR = '#2A2A2A';

function useShimmer() {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);

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
  const opacity = useShimmer();
  return (
    <Animated.View
      style={[styles.box, { width, height, borderRadius, opacity }]}
    />
  );
}

// ---------------------------------------------------------------------------
// SkeletonRow — circle avatar + two lines
// ---------------------------------------------------------------------------

export function SkeletonRow() {
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

const styles = StyleSheet.create({
  box: {
    backgroundColor: SKELETON_COLOR,
  },
  circle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: SKELETON_COLOR,
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
    backgroundColor: '#1C1C1C',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  body: {
    marginTop: 16,
  },
});
