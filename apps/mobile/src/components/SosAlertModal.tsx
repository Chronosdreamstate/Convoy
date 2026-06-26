import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Linking,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { HapticService } from '../services/HapticService';

const COUNTDOWN_START = 5;

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
  const [countdown, setCountdown] = useState(COUNTDOWN_START);
  const [cancelled, setCancelled] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timestampRef = useRef<string>('');

  // Stable callback refs so the interval never stale-closes over props
  const onAcknowledgeRef = useRef(onAcknowledge);
  const onDismissRef = useRef(onDismiss);
  useEffect(() => { onAcknowledgeRef.current = onAcknowledge; }, [onAcknowledge]);
  useEffect(() => { onDismissRef.current = onDismiss; }, [onDismiss]);

  // Record timestamp and reset state each time modal opens
  useEffect(() => {
    if (!visible) return;
    timestampRef.current = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    setCancelled(false);
    setCountdown(COUNTDOWN_START);
  }, [visible]);

  // Pulse animation — scale 1.0 → 1.2 → 1.0 over 800ms total
  useEffect(() => {
    if (!visible) return;

    HapticService.trigger('error');

    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.2, duration: 400, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1.0, duration: 400, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => { anim.stop(); pulse.setValue(1); };
  }, [visible, pulse]);

  // Countdown timer — auto-triggers group alert when it reaches 0
  useEffect(() => {
    if (!visible || cancelled) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(intervalRef.current!);
          intervalRef.current = null;
          // Defer callbacks outside the state-update cycle
          setTimeout(() => {
            onAcknowledgeRef.current();
            onDismissRef.current();
          }, 0);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [visible, cancelled]);

  const handleCall911 = () => {
    Linking.openURL('tel:911');
  };

  const handleCancel = () => {
    setCancelled(true);
  };

  const handleAlertGroup = () => {
    setCancelled(true);
    onAcknowledgeRef.current();
    onDismissRef.current();
  };

  const handleDismiss = () => {
    setCancelled(true);
    onDismiss();
  };

  const coordLabel = `${locationLat.toFixed(5)}, ${locationLng.toFixed(5)}`;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={handleDismiss}
    >
      <View style={styles.overlay}>
        <View style={styles.card}>

          {/* Pulsing SOS icon */}
          <Animated.View style={[styles.iconCircle, { transform: [{ scale: pulse }] }]}>
            <Text style={styles.iconText}>🆘</Text>
          </Animated.View>

          {/* Timestamp beneath the icon */}
          <Text style={styles.timestamp}>SOS at {timestampRef.current}</Text>

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

          {/* Call 911 — large crimson primary button */}
          <TouchableOpacity
            style={styles.call911Btn}
            onPress={handleCall911}
            accessibilityRole="button"
            accessibilityLabel="Call 911"
          >
            <Text style={styles.call911BtnText}>📞  Call 911</Text>
          </TouchableOpacity>

          {/* Countdown banner with Cancel chip */}
          {!cancelled && countdown > 0 && (
            <View style={styles.countdownRow}>
              <Text style={styles.countdownText}>Alerting group in {countdown}s…</Text>
              <TouchableOpacity
                style={styles.cancelChip}
                onPress={handleCancel}
                accessibilityRole="button"
                accessibilityLabel="Cancel auto-alert"
              >
                <Text style={styles.cancelChipText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Share Location */}
          <TouchableOpacity
            style={styles.shareBtn}
            onPress={onNavigate}
            accessibilityRole="button"
            accessibilityLabel="Share location"
          >
            <Text style={styles.shareBtnText}>📍  Share Location</Text>
          </TouchableOpacity>

          {/* Alert Group */}
          <TouchableOpacity
            style={styles.alertGroupBtn}
            onPress={handleAlertGroup}
            accessibilityRole="button"
            accessibilityLabel="Alert my group"
          >
            <Text style={styles.alertGroupBtnText}>🚨  Alert Group</Text>
          </TouchableOpacity>

          {/* Dismiss */}
          <TouchableOpacity
            style={styles.dismissBtn}
            onPress={handleDismiss}
            accessibilityRole="button"
            accessibilityLabel="Dismiss alert"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.dismissBtnText}>Dismiss</Text>
          </TouchableOpacity>

          {/* Footer message */}
          <Text style={styles.footerNote}>
            Your convoy group will be notified with your location
          </Text>

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
    marginBottom: 8,
  },
  iconText: {
    fontSize: 36,
  },
  timestamp: {
    fontSize: 12,
    color: '#888888',
    marginBottom: 12,
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
    marginBottom: 20,
    textAlign: 'center',
  },
  // Call 911 — large, crimson, prominent
  call911Btn: {
    backgroundColor: '#DC143C',
    borderRadius: 14,
    paddingVertical: 16,
    width: '100%',
    alignItems: 'center',
    marginBottom: 12,
    minHeight: 56,
    justifyContent: 'center',
  },
  call911BtnText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 1,
  },
  // Countdown row
  countdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  countdownText: {
    color: '#F59E0B',
    fontSize: 13,
    fontWeight: '600',
  },
  cancelChip: {
    backgroundColor: '#2C2C2C',
    borderRadius: 20,
    paddingVertical: 4,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#444444',
    marginLeft: 10,
  },
  cancelChipText: {
    color: '#888888',
    fontSize: 12,
    fontWeight: '600',
  },
  // Share Location — outlined crimson
  shareBtn: {
    borderRadius: 12,
    paddingVertical: 14,
    width: '100%',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#DC143C',
    marginBottom: 10,
    minHeight: 50,
    justifyContent: 'center',
  },
  shareBtnText: {
    color: '#DC143C',
    fontSize: 16,
    fontWeight: '700',
  },
  // Alert Group — outlined green
  alertGroupBtn: {
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
  alertGroupBtnText: {
    color: '#22C55E',
    fontSize: 16,
    fontWeight: '600',
  },
  dismissBtn: {
    paddingVertical: 10,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
    marginBottom: 10,
  },
  dismissBtnText: {
    color: '#888888',
    fontSize: 14,
    fontWeight: '500',
  },
  footerNote: {
    fontSize: 12,
    color: '#888888',
    textAlign: 'center',
    lineHeight: 18,
  },
});
