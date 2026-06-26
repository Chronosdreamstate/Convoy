import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { HapticService } from '../services/HapticService';

interface Props {
  memberName: string;
  distanceM: number;
  thresholdM: number;
  onDismiss: () => void;
  onSlowDown?: () => void;
}

function formatDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function GapAlertBanner({ memberName, distanceM, thresholdM, onDismiss, onSlowDown }: Props) {
  const slideY = useRef(new Animated.Value(-80)).current;
  const progress = useRef(new Animated.Value(1)).current;
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    HapticService.trigger('warning');
    Animated.spring(slideY, {
      toValue: 0,
      damping: 20,
      stiffness: 180,
      useNativeDriver: true,
    }).start();

    Animated.timing(progress, {
      toValue: 0,
      duration: 10000,
      useNativeDriver: false,
    }).start();

    dismissTimer.current = setTimeout(onDismiss, 10000);
    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    };
  }, []);

  const handleDismiss = () => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    onDismiss();
  };

  const progressWidth = progress.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <Animated.View style={[styles.container, { transform: [{ translateY: slideY }] }]}>
      <View style={styles.strip} />
      <View style={styles.content}>
        <View style={styles.main}>
          <Text style={styles.emoji}>⚠️</Text>
          <View style={styles.textBlock}>
            <Text style={styles.title} numberOfLines={1}>
              <Text style={styles.bold}>{memberName}</Text> is falling behind
            </Text>
            <Text style={styles.subtitle}>
              {formatDist(distanceM)} behind — threshold {formatDist(thresholdM)}
            </Text>
          </View>
          <View style={styles.actions}>
            {onSlowDown ? (
              <TouchableOpacity style={styles.slowBtn} onPress={onSlowDown} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
                <Text style={styles.slowBtnText}>Slow Down</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={styles.dismissBtn} onPress={handleDismiss} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.dismissText}>✕</Text>
            </TouchableOpacity>
          </View>
        </View>
        <View style={styles.progressTrack}>
          <Animated.View style={[styles.progressBar, { width: progressWidth }]} />
        </View>
      </View>
    </Animated.View>
  );
}

const MemoGapAlertBanner = React.memo(GapAlertBanner);
MemoGapAlertBanner.displayName = 'GapAlertBanner';
export default MemoGapAlertBanner;

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: '#1C1C1C',
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    overflow: 'hidden',
  },
  strip: {
    width: 4,
    backgroundColor: '#F59E0B',
  },
  content: {
    flex: 1,
  },
  main: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 10,
  },
  emoji: {
    fontSize: 20,
  },
  textBlock: {
    flex: 1,
  },
  title: {
    fontSize: 15,
    color: '#FFFFFF',
    lineHeight: 20,
  },
  bold: {
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 13,
    color: '#888888',
    marginTop: 2,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  slowBtn: {
    borderWidth: 1,
    borderColor: '#F59E0B',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  slowBtnText: {
    color: '#F59E0B',
    fontSize: 13,
    fontWeight: '600',
  },
  dismissBtn: {
    padding: 4,
  },
  dismissText: {
    color: '#888888',
    fontSize: 16,
  },
  progressTrack: {
    height: 3,
    backgroundColor: '#2A2A2A',
  },
  progressBar: {
    height: 3,
    backgroundColor: '#F59E0B',
  },
});
