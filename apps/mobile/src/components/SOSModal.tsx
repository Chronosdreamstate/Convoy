import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Linking,
} from 'react-native';
import { useSocketStore } from '../stores/socketStore';

interface SOSModalProps {
  visible: boolean;
  onClose: () => void;
  groupId: string;
}

export default function SOSModal({ visible, onClose, groupId }: SOSModalProps) {
  const socket = useSocketStore((s) => s.socket);

  function emitAlert(type: 'sos' | 'breakdown', message: string) {
    if (socket?.connected) {
      socket.emit('convoy:alert', { type, message, groupId });
    }
  }

  function handleBreakdown() {
    emitAlert('breakdown', 'Breakdown — convoy member needs to stop');
    onClose();
  }

  function handleMedical() {
    Linking.openURL('tel:911');
    onClose();
  }

  function handleConvoyHalt() {
    emitAlert('sos', 'SOS — convoy halt requested');
    onClose();
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <Text style={styles.header}>EMERGENCY</Text>

          {/* Breakdown */}
          <TouchableOpacity
            style={[styles.actionButton, styles.breakdownButton]}
            onPress={handleBreakdown}
            activeOpacity={0.8}
          >
            <Text style={styles.actionIcon}>🚗</Text>
            <Text style={styles.actionLabel}>Breakdown — I Need to Stop</Text>
          </TouchableOpacity>

          {/* Medical */}
          <TouchableOpacity
            style={[styles.actionButton, styles.medicalButton]}
            onPress={handleMedical}
            activeOpacity={0.8}
          >
            <Text style={styles.actionIcon}>🚨</Text>
            <Text style={styles.actionLabel}>Medical Emergency — Call 911</Text>
          </TouchableOpacity>

          {/* Convoy Halt */}
          <TouchableOpacity
            style={[styles.actionButton, styles.haltButton]}
            onPress={handleConvoyHalt}
            activeOpacity={0.8}
          >
            <Text style={styles.actionIcon}>🛑</Text>
            <Text style={styles.actionLabel}>Convoy Halt — Stop Everyone</Text>
          </TouchableOpacity>

          {/* Cancel */}
          <TouchableOpacity style={styles.cancelButton} onPress={onClose} activeOpacity={0.7}>
            <Text style={styles.cancelLabel}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.8)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#1C1C1C',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 36,
  },
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
    backgroundColor: '#2A2A2A',
  },
  cancelLabel: {
    color: '#888888',
    fontSize: 16,
    fontWeight: '600',
  },
});
