import React, { useEffect, useState } from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { HapticService } from '../services/HapticService';
import SOSModal from './SOSModal';

interface SOSButtonProps {
  groupId: string;
}

export default function SOSButton({ groupId }: SOSButtonProps) {
  const [modalVisible, setModalVisible] = useState(false);
  const isFocused = useIsFocused();

  function handlePress() {
    HapticService.trigger('warning');
    setModalVisible(true);
  }

  // Background tab screens stay mounted (no unmountOnBlur/lazy-freeze
  // configured on the tab navigator), so this component — and its native
  // <Modal> — can remain alive after the user switches tabs. Force-close
  // the modal on blur so it can never linger behind another tab's screen
  // and stack with that screen's own modals (e.g. MapScreen's SosAlertModal).
  useEffect(() => {
    if (!isFocused) {
      setModalVisible(false);
    }
  }, [isFocused]);

  return (
    <>
      <TouchableOpacity
        style={styles.button}
        onPress={handlePress}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="SOS emergency options"
        accessibilityHint="Opens emergency actions: breakdown, medical, or convoy halt"
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Text style={styles.label}>SOS</Text>
      </TouchableOpacity>

      <SOSModal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        groupId={groupId}
      />
    </>
  );
}

// Emergency red is intentionally fixed (not theme-adaptive) for urgency/
// visibility, matching the app's other SOS/emergency surfaces.
const styles = StyleSheet.create({
  button: {
    // 64x64 — large, easy-to-hit target for driving-context use, matching
    // the SOS control size used elsewhere in the app (e.g. MapScreen).
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#DC143C',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#DC143C',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 6,
    elevation: 6,
  },
  label: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 1,
  },
});
