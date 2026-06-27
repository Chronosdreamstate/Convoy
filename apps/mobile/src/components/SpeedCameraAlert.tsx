import React, { useEffect, useRef } from 'react';
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { SpeedCamera } from '../services/SpeedAlertService';
import { speedAlertService } from '../services/SpeedAlertService';

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

  return (
    <Animated.View
      style={[
        styles.container,
        { transform: [{ translateY: slideAnim }], opacity: opacityAnim },
      ]}
    >
      <View style={styles.header}>
        <Text style={styles.title}>{label}</Text>
        <Text style={styles.distance}>{distLabel} ahead</Text>
      </View>
      {camera.speedLimitKph != null && (
        <Text style={styles.speedLimit}>Speed limit: {camera.speedLimitKph} km/h</Text>
      )}
      <View style={styles.actions}>
        <TouchableOpacity style={styles.confirmBtn} onPress={handleConfirm}>
          <Text style={styles.confirmText}>✓ Confirm</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.denyBtn} onPress={handleNotThere}>
          <Text style={styles.denyText}>✗ Not There</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 140,
    left: 16,
    right: 16,
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    borderLeftWidth: 4,
    borderLeftColor: '#F59E0B',
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
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  distance: {
    color: '#F59E0B',
    fontSize: 13,
    fontWeight: '600',
  },
  speedLimit: {
    color: '#888888',
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
    backgroundColor: '#22C55E22',
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#22C55E55',
  },
  confirmText: {
    color: '#22C55E',
    fontSize: 13,
    fontWeight: '600',
  },
  denyBtn: {
    flex: 1,
    backgroundColor: '#DC143C22',
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#DC143C55',
  },
  denyText: {
    color: '#DC143C',
    fontSize: 13,
    fontWeight: '600',
  },
});
