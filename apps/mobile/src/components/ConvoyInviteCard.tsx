/**
 * ConvoyInviteCard — standalone invite modal component.
 * Shows the group name, join code, and a native share button.
 */

import React from 'react';
import {
  Modal,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

interface Props {
  visible: boolean;
  groupName: string;
  joinCode: string;
  inviteLink: string;
  onClose: () => void;
}

export default function ConvoyInviteCard({ visible, groupName, joinCode, inviteLink, onClose }: Props) {
  const handleShare = async () => {
    try {
      await Share.share({
        message: `Join me on CONVOY! Use code ${joinCode} or tap: ${inviteLink}`,
        url: inviteLink,
      });
    } catch {
      // user cancelled share sheet
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      <TouchableOpacity
        style={styles.overlay}
        activeOpacity={1}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close invite card"
      >
        {/* Inner wrapper swallows touches so tapping the card doesn't close it */}
        <TouchableOpacity activeOpacity={1} onPress={() => {}}>
          <View style={styles.card}>
            <Text style={styles.groupName}>{groupName}</Text>
            <Text style={styles.subtitle}>Share this code to invite friends</Text>

            <View style={styles.codeBox}>
              <Text style={styles.codeText} accessibilityLabel={`Join code: ${joinCode}`}>
                {joinCode}
              </Text>
            </View>

            <TouchableOpacity
              style={styles.shareBtn}
              onPress={() => void handleShare()}
              accessibilityRole="button"
              accessibilityLabel="Share invite link"
            >
              <Text style={styles.shareBtnText}>📤 Share Invite</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.closeBtn}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close invite card"
            >
              <Text style={styles.closeBtnText}>✕ Close</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 24,
    width: 320,
    alignItems: 'center',
  },
  groupName: {
    color: '#0A0A0A',
    fontSize: 22,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    color: '#888888',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 20,
  },
  codeBox: {
    backgroundColor: '#0A0A0A',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 16,
    width: '100%',
    alignItems: 'center',
    marginBottom: 20,
  },
  codeText: {
    color: '#DC143C',
    fontSize: 32,
    fontWeight: '800',
    fontFamily: 'monospace',
    letterSpacing: 6,
    textAlign: 'center',
  },
  shareBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 32,
    width: '100%',
    alignItems: 'center',
    marginBottom: 12,
    minHeight: 52,
    justifyContent: 'center',
  },
  shareBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  closeBtn: {
    paddingVertical: 10,
  },
  closeBtnText: {
    color: '#888888',
    fontSize: 15,
    fontWeight: '600',
  },
});
