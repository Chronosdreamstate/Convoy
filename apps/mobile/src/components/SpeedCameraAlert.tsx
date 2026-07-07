import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { SpeedCamera } from '../services/SpeedAlertService';
import { speedAlertService } from '../services/SpeedAlertService';
import { ThemeColors, useTheme, withAlpha } from '../theme';

interface Props {
  camera: SpeedCamera;
  distanceM: number;
  onDismiss: () => void;
}

const TYPE_LABELS: Record<SpeedCamera['type'], string> = {
  fixed: '📸 Fixed Camera',
  mobile: '🚔 Mobile Speed Trap',
  avg_speed: '📏 Avg Speed Zone',
  red_light: '🚦 Red Light Camera',
};

export default function SpeedCameraAlert({ camera, distanceM, onDismiss }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const slideAnim = useRef(new Animated.Value(-120)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, tension: 80, friction: 10 }),
      Animated.timing(opacityAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
    ]).start();

    const timer = setTimeout(() => dismiss(), 8000);
    return () => clearTimeout(timer);
  }, []);

  function dismiss() {
    Animated.parallel([
      Animated.timing(slideAnim, { toValue: -120, duration: 250, useNativeDriver: true }),
      Animated.timing(opacityAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => onDismiss());
  }

  function handleConfirm() {
    speedAlertService.voteOnCamera(camera.id, 'confirm');
    dismiss();
  }

  function handleNotThere() {
    speedAlertService.voteOnCamera(camera.id, 'deny');
    dismiss();
  }

  const label = TYPE_LABELS[camera.type] ?? '📸 Speed Camera';
  const distLabel = distanceM >= 1000
    ? `${(distanceM / 1000).toFixed(1)} km`
    : `${distanceM}m`;

  const a11yLabel = `${label.replace(/^[^\w]+\s*/, '')}, ${distLabel} ahead${
    camera.speedLimitKph != null ? `. Speed limit ${camera.speedLimitKph} kilometers per hour` : ''
  }`;

  return (
    <Animated.View
      style={[
        styles.container,
        { transform: [{ translateY: slideAnim }], opacity: opacityAnim },
      ]}
      accessibilityLiveRegion="assertive"
    >
      {/* Info block gets one combined a11y label (rather than accessible on the
          whole container) so the Confirm/Not There buttons below stay
          individually reachable for screen-reader users. */}
      <View accessible accessibilityRole="alert" accessibilityLabel={a11yLabel}>
        <View style={styles.header}>
          <Text style={styles.title}>{label}</Text>
          <Text style={styles.distance}>{distLabel} ahead</Text>
        </View>
        {camera.speedLimitKph != null && (
          <Text style={styles.speedLimit}>Speed limit: {camera.speedLimitKph} km/h</Text>
        )}
      </View>
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.confirmBtn}
          onPress={handleConfirm}
          accessibilityRole="button"
          accessibilityLabel="Confirm camera still there"
          hitSlop={{ top: 8, bottom: 8, left: 0, right: 0 }}
        >
          <Text style={styles.confirmText}>✓ Confirm</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.denyBtn}
          onPress={handleNotThere}
          accessibilityRole="button"
          accessibilityLabel="Report camera not there"
          hitSlop={{ top: 8, bottom: 8, left: 0, right: 0 }}
        >
          <Text style={styles.denyText}>✗ Not There</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      position: 'absolute',
      top: 140,
      left: 16,
      right: 16,
      backgroundColor: colors.card,
      borderRadius: 12,
      borderLeftWidth: 4,
      // Amber warning strip — themed via colors.warning (matches the same
      // convention used by GapAlertBanner) rather than a fixed hex.
      borderLeftColor: colors.warning,
      padding: 12,
      shadowColor: '#000',
      shadowOpacity: 0.4,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 4 },
      elevation: 8,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 4,
    },
    title: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '700',
    },
    distance: {
      color: colors.warning,
      fontSize: 13,
      fontWeight: '600',
    },
    speedLimit: {
      color: colors.textMuted,
      fontSize: 12,
      marginBottom: 8,
    },
    actions: {
      flexDirection: 'row',
      gap: 8,
      marginTop: 8,
    },
    confirmBtn: {
      flex: 1,
      backgroundColor: withAlpha(colors.success, 0.13),
      borderRadius: 8,
      paddingVertical: 8,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: withAlpha(colors.success, 0.33),
    },
    confirmText: {
      color: colors.success,
      fontSize: 13,
      fontWeight: '600',
    },
    denyBtn: {
      flex: 1,
      backgroundColor: withAlpha(colors.error, 0.13),
      borderRadius: 8,
      paddingVertical: 8,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: withAlpha(colors.error, 0.33),
    },
    denyText: {
      color: colors.error,
      fontSize: 13,
      fontWeight: '600',
    },
  });
}
