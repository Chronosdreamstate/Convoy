/**
 * ConvoyInviteCard — standalone invite modal component.
 * Shows the group name, join code, and a native share button.
 */

import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ThemeColors, useTheme } from '../theme';

interface Props {
  visible: boolean;
  groupName: string;
  joinCode: string;
  inviteLink: string;
  onClose: () => void;
}

export default function ConvoyInviteCard({ visible, groupName, joinCode, inviteLink, onClose }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [sharing, setSharing] = useState(false);

  const handleShare = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      await Share.share({
        message: `Join me on CORTEGE! Use code ${joinCode} or tap: ${inviteLink}`,
        url: inviteLink,
      });
    } catch {
      Alert.alert('Error', 'Could not open the share sheet. Try again.');
    } finally {
      setSharing(false);
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
              style={[styles.shareBtn, sharing && styles.shareBtnDisabled]}
              onPress={() => void handleShare()}
              disabled={sharing}
              accessibilityRole="button"
              accessibilityLabel="Share invite link"
              accessibilityState={{ disabled: sharing, busy: sharing }}
            >
              {sharing ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <>
                  <Ionicons name="share-social-outline" size={18} color="#FFFFFF" style={styles.shareIcon} />
                  <Text style={styles.shareBtnText}>Share Invite</Text>
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.closeBtn}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close invite card"
            >
              <Ionicons name="close" size={16} color={colors.textMuted} style={styles.closeIcon} />
              <Text style={styles.closeBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.75)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    card: {
      backgroundColor: colors.card,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 24,
      width: 320,
      alignItems: 'center',
    },
    groupName: {
      color: colors.text,
      fontSize: 22,
      fontWeight: '800',
      textAlign: 'center',
      marginBottom: 8,
    },
    subtitle: {
      color: colors.textMuted,
      fontSize: 14,
      textAlign: 'center',
      marginBottom: 20,
    },
    codeBox: {
      backgroundColor: colors.bg,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      paddingVertical: 16,
      paddingHorizontal: 16,
      width: '100%',
      alignItems: 'center',
      marginBottom: 20,
    },
    codeText: {
      color: colors.accent,
      fontSize: 32,
      fontWeight: '800',
      fontFamily: 'monospace',
      letterSpacing: 6,
      textAlign: 'center',
    },
    shareBtn: {
      flexDirection: 'row',
      backgroundColor: colors.accent,
      borderRadius: 12,
      paddingVertical: 16,
      paddingHorizontal: 32,
      width: '100%',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 12,
      minHeight: 52,
    },
    shareBtnDisabled: {
      opacity: 0.7,
    },
    shareIcon: {
      marginRight: 8,
    },
    shareBtnText: {
      color: '#FFFFFF',
      fontSize: 16,
      fontWeight: '700',
    },
    closeBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      minHeight: 44,
      justifyContent: 'center',
    },
    closeIcon: {
      marginRight: 4,
    },
    closeBtnText: {
      color: colors.textMuted,
      fontSize: 15,
      fontWeight: '600',
    },
  });
}
