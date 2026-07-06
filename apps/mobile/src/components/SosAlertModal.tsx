import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Linking,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { HapticService } from '../services/HapticService';
import { ThemeColors, useTheme } from '../theme';

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
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
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
      accessibilityViewIsModal
    >
      <View style={styles.overlay}>
        <View style={styles.card} accessibilityLabel="SOS alert">

          {/* Pulsing SOS icon */}
          <Animated.View style={[styles.iconCircle, { transform: [{ scale: pulse }] }]}>
            <MaterialIcons name="sos" size={36} color="#FFFFFF" />
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
            <Ionicons name="call" size={18} color="#FFFFFF" />
            <Text style={styles.call911BtnText}>  Call 911</Text>
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
            <Ionicons name="location" size={18} color={colors.accent} />
            <Text style={styles.shareBtnText}>  Share Location</Text>
          </TouchableOpacity>

          {/* Alert Group */}
          <TouchableOpacity
            style={styles.alertGroupBtn}
            onPress={handleAlertGroup}
            accessibilityRole="button"
            accessibilityLabel="Alert my group"
          >
            <Ionicons name="megaphone" size={18} color={colors.success} />
            <Text style={styles.alertGroupBtnText}>  Alert Group</Text>
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

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.85)',
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 24,
    },
    card: {
      backgroundColor: colors.card,
      borderRadius: 20,
      padding: 32,
      width: '100%',
      maxWidth: 360,
      alignItems: 'center',
    },
    // iconCircle/call911Btn use the fixed-value accent color (same in both
    // themes), so their icon/text stay fixed white for contrast.
    iconCircle: {
      width: 72,
      height: 72,
      borderRadius: 36,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 8,
    },
    timestamp: {
      fontSize: 12,
      color: colors.textMuted,
      marginBottom: 12,
    },
    title: {
      fontSize: 22,
      fontWeight: '900',
      color: colors.accent,
      letterSpacing: 3,
      marginBottom: 10,
      textAlign: 'center',
    },
    body: {
      fontSize: 16,
      color: colors.text,
      textAlign: 'center',
      lineHeight: 22,
      marginBottom: 16,
    },
    memberName: {
      fontWeight: '700',
    },
    messageCard: {
      backgroundColor: colors.bg,
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
      color: colors.textMuted,
      marginBottom: 20,
      textAlign: 'center',
    },
    // Call 911 — large, crimson, prominent
    call911Btn: {
      flexDirection: 'row',
      backgroundColor: colors.accent,
      borderRadius: 14,
      paddingVertical: 16,
      width: '100%',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 12,
      minHeight: 56,
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
      color: colors.warning,
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
      flexDirection: 'row',
      borderRadius: 12,
      paddingVertical: 14,
      width: '100%',
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1.5,
      borderColor: colors.accent,
      marginBottom: 10,
      minHeight: 50,
    },
    shareBtnText: {
      color: colors.accent,
      fontSize: 16,
      fontWeight: '700',
    },
    // Alert Group — outlined green
    alertGroupBtn: {
      flexDirection: 'row',
      borderRadius: 12,
      paddingVertical: 14,
      width: '100%',
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1.5,
      borderColor: colors.success,
      marginBottom: 10,
      minHeight: 50,
    },
    alertGroupBtnText: {
      color: colors.success,
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
      color: colors.textMuted,
      fontSize: 14,
      fontWeight: '500',
    },
    footerNote: {
      fontSize: 12,
      color: colors.textMuted,
      textAlign: 'center',
      lineHeight: 18,
    },
  });
}
