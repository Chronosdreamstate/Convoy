import React, { useState } from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { HapticService } from '../services/HapticService';
import SOSModal from './SOSModal';

interface SOSButtonProps {
  groupId: string;
}

export default function SOSButton({ groupId }: SOSButtonProps) {
  const [modalVisible, setModalVisible] = useState(false);

  function handlePress() {
    HapticService.trigger('warning');
    setModalVisible(true);
  }

  return (
    <>
      <TouchableOpacity style={styles.button} onPress={handlePress} activeOpacity={0.8}>
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

const styles = StyleSheet.create({
  button: {
    width: 52,
    height: 52,
    borderRadius: 26,
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
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
  },
});
