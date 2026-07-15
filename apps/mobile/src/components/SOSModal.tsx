import React, { useMemo } from 'react';
import {
  Alert,
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Linking,
} from 'react-native';
import { useSocketStore } from '../stores/socketStore';
import { ThemeColors, useTheme } from '../theme';

interface SOSModalProps {
  visible: boolean;
  onClose: () => void;
  groupId: string;
}

export default function SOSModal({ visible, onClose, groupId }: SOSModalProps) {
  const socket = useSocketStore((s) => s.socket);
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  /** Returns true when the alert actually went out. */
  function emitAlert(type: 'sos' | 'breakdown', message: string): boolean {
    if (socket?.connected) {
      socket.emit('convoy:alert', { type, message, groupId });
      return true;
    }
    return false;
  }

  /**
   * An emergency action must never fail silently (Req 43): when the socket is
   * down, keep the sheet open and tell the user their convoy was NOT alerted —
   * with the one channel that doesn't depend on this app's connectivity.
   */
  function sendOrWarn(type: 'sos' | 'breakdown', message: string) {
    if (emitAlert(type, message)) {
      onClose();
      return;
    }
    Alert.alert(
      'Convoy Not Alerted',
      "You're offline, so your convoy did not receive this alert. If this is a real emergency, call 911 directly.",
      [
        { text: 'Call 911', onPress: () => { void Linking.openURL('tel:911'); } },
        { text: 'OK', style: 'cancel' },
      ],
    );
  }

  function handleBreakdown() {
    sendOrWarn('breakdown', 'Breakdown — convoy member needs to stop');
  }

  function handleMedical() {
    Linking.openURL('tel:911');
    onClose();
  }

  function handleConvoyHalt() {
    sendOrWarn('sos', 'SOS — convoy halt requested');
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <Text style={styles.header} accessibilityRole="header">EMERGENCY</Text>

          {/* Breakdown */}
          <TouchableOpacity
            style={[styles.actionButton, styles.breakdownButton]}
            onPress={handleBreakdown}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Breakdown — I need to stop"
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          >
            <Text style={styles.actionIcon}>🚗</Text>
            <Text style={styles.actionLabel}>Breakdown — I Need to Stop</Text>
          </TouchableOpacity>

          {/* Medical */}
          <TouchableOpacity
            style={[styles.actionButton, styles.medicalButton]}
            onPress={handleMedical}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Medical emergency, call 911"
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          >
            <Text style={styles.actionIcon}>🚨</Text>
            <Text style={styles.actionLabel}>Medical Emergency — Call 911</Text>
          </TouchableOpacity>

          {/* Convoy Halt */}
          <TouchableOpacity
            style={[styles.actionButton, styles.haltButton]}
            onPress={handleConvoyHalt}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Convoy halt, stop everyone"
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          >
            <Text style={styles.actionIcon}>🛑</Text>
            <Text style={styles.actionLabel}>Convoy Halt — Stop Everyone</Text>
          </TouchableOpacity>

          {/* Cancel */}
          <TouchableOpacity
            style={styles.cancelButton}
            onPress={onClose}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Cancel, close emergency menu"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.cancelLabel}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.8)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: colors.bg,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingHorizontal: 20,
      paddingTop: 24,
      paddingBottom: 36,
    },
    // Emergency red is intentionally fixed (not theme-adaptive) — it signals
    // urgency and must read the same in light or dark mode.
    header: {
      color: '#DC143C',
      fontSize: 22,
      fontWeight: '800',
      letterSpacing: 2,
      textAlign: 'center',
      marginBottom: 20,
    },
    actionButton: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 12,
      paddingVertical: 18,
      paddingHorizontal: 16,
      marginBottom: 12,
    },
    // Each action's background is a fixed severity color (amber = breakdown,
    // red = medical, dark red = convoy halt) — intentionally not theme-adaptive
    // so the color coding stays consistent and unambiguous in any mode.
    breakdownButton: {
      backgroundColor: '#F59E0B',
    },
    medicalButton: {
      backgroundColor: '#DC143C',
    },
    haltButton: {
      backgroundColor: '#8B0000',
    },
    actionIcon: {
      fontSize: 22,
      marginRight: 14,
    },
    // White text is fixed to stay legible against the fixed-color action
    // backgrounds above, regardless of theme.
    actionLabel: {
      color: '#FFFFFF',
      fontSize: 16,
      fontWeight: '700',
      flexShrink: 1,
    },
    cancelButton: {
      marginTop: 4,
      paddingVertical: 16,
      alignItems: 'center',
      borderRadius: 12,
      backgroundColor: colors.card,
    },
    cancelLabel: {
      color: colors.textMuted,
      fontSize: 16,
      fontWeight: '600',
    },
  });
}
