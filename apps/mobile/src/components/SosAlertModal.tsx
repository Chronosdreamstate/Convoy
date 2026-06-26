import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { HapticService } from '../services/HapticService';

interface Props {
  visible: boolean;
  memberName: string;
  locationLat: number;
  locationLng: number;
  message?: string;
  onNavigate: () => void;
  onDismiss: () => void;
  onAcknowledge: () => void;
}

export default function SosAlertModal({
  visible,
  memberName,
  locationLat,
  locationLng,
  message,
  onNavigate,
  onDismiss,
  onAcknowledge,
}: Props) {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!visible) return;

    HapticService.trigger('error');

    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.1, duration: 500, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1.0, duration: 500, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => { anim.stop(); pulse.setValue(1); };
  }, [visible, pulse]);

  const handleAcknowledge = () => {
    onAcknowledge();
    onDismiss();
  };

  const coordLabel = `${locationLat.toFixed(5)}, ${locationLng.toFixed(5)}`;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onDismiss}
    >
      <View style={styles.overlay}>
        <View style={styles.card}>
          {/* Pulsing SOS icon */}
          <Animated.View style={[styles.iconCircle, { transform: [{ scale: pulse }] }]}>
            <Text style={styles.iconText}>🆘</Text>
          </Animated.View>

          <Text style={styles.title}>SOS ALERT</Text>
          <Text style={styles.body}>
            <Text style={styles.memberName}>{memberName}</Text>
            {' has sent an emergency alert'}
          </Text>

          {message ? (
            <View style={styles.messageCard}>
              <Text style={styles.messageText}>{message}</Text>
            </View>
          ) : null}

          <Text style={styles.coords}>📍 {coordLabel}</Text>

          {/* Navigate */}
          <TouchableOpacity
            style={styles.navigateBtn}
            onPress={onNavigate}
            accessibilityRole="button"
            accessibilityLabel={`Navigate to ${memberName}`}
          >
            <Text style={styles.navigateBtnText}>📍 Navigate to {memberName}</Text>
          </TouchableOpacity>

          {/* Acknowledge */}
          <TouchableOpacity
            style={styles.acknowledgeBtn}
            onPress={handleAcknowledge}
            accessibilityRole="button"
            accessibilityLabel="I'm on my way"
          >
            <Text style={styles.acknowledgeBtnText}>✓  I'm on my way</Text>
          </TouchableOpacity>

          {/* Dismiss */}
          <TouchableOpacity
            style={styles.dismissBtn}
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityLabel="Dismiss alert"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.dismissBtnText}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    backgroundColor: '#1C1C1C',
    borderRadius: 20,
    padding: 32,
    width: '100%',
    maxWidth: 360,
    alignItems: 'center',
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#DC143C',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  iconText: {
    fontSize: 36,
  },
  title: {
    fontSize: 22,
    fontWeight: '900',
    color: '#DC143C',
    letterSpacing: 3,
    marginBottom: 10,
    textAlign: 'center',
  },
  body: {
    fontSize: 16,
    color: '#FFFFFF',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 16,
  },
  memberName: {
    fontWeight: '700',
  },
  messageCard: {
    backgroundColor: '#0A0A0A',
    borderRadius: 10,
    padding: 12,
    width: '100%',
    marginBottom: 12,
  },
  messageText: {
    fontSize: 14,
    color: '#CCCCCC',
    lineHeight: 20,
    textAlign: 'center',
    fontStyle: 'italic',
  },
  coords: {
    fontSize: 12,
    color: '#888888',
    marginBottom: 24,
    textAlign: 'center',
  },
  navigateBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 12,
    paddingVertical: 14,
    width: '100%',
    alignItems: 'center',
    marginBottom: 10,
    minHeight: 50,
    justifyContent: 'center',
  },
  navigateBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  acknowledgeBtn: {
    borderRadius: 12,
    paddingVertical: 14,
    width: '100%',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#22C55E',
    marginBottom: 10,
    minHeight: 50,
    justifyContent: 'center',
  },
  acknowledgeBtnText: {
    color: '#22C55E',
    fontSize: 16,
    fontWeight: '600',
  },
  dismissBtn: {
    paddingVertical: 10,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  dismissBtnText: {
    color: '#888888',
    fontSize: 14,
    fontWeight: '500',
  },
});
