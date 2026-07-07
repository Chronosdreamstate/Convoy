import React, { useMemo, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Share,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useGroupStore } from '../stores/groupStore';
import { apiClient } from '../services/apiClient';
import { ThemeColors, useTheme } from '../theme';

interface MemberInfo {
  userId: string;
  displayName: string;
  callsign: string | null;
  isAdmin: boolean;
  isOnline: boolean;
  speedKph?: number;
  distanceM?: number;
  isMuted?: boolean;
}

interface Props {
  visible: boolean;
  member: MemberInfo | null;
  isCurrentUserAdmin: boolean;
  onClose: () => void;
  onMute?: (userId: string, mute: boolean) => void;
  onKick?: (userId: string) => void;
  onNavigateTo?: (userId: string) => void;
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
}

export default function MemberDetailModal({
  visible,
  member,
  isCurrentUserAdmin,
  onClose,
  onMute,
  onKick,
  onNavigateTo,
}: Props) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const activeGroupId = useGroupStore((s) => s.activeGroupId);
  const [friendSent, setFriendSent] = useState(false);
  const [addingFriend, setAddingFriend] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [kicking, setKicking] = useState(false);
  const [muting, setMuting] = useState(false);

  if (!member) return null;

  const showAdminControls = isCurrentUserAdmin;

  const handleInviteToConvoy = async () => {
    if (!activeGroupId) return;
    setInviting(true);
    try {
      const res = await apiClient.get<{ code: string; link: string }>(
        `/api/v1/groups/${activeGroupId}/invite-link`,
      );
      await Share.share({
        message: `Join my convoy on CORTEGE! Code: ${res.data.code}\n${res.data.link}`,
      });
    } catch {
      Alert.alert('Error', 'Could not get invite link. Try again.');
    } finally {
      setInviting(false);
    }
  };

  const handleAddFriend = async () => {
    if (addingFriend || friendSent) return;
    setAddingFriend(true);
    try {
      await apiClient.post('/api/v1/friends/requests', { addresseeId: member.userId });
      setFriendSent(true);
    } catch {
      Alert.alert('Error', 'Could not send friend request. Try again.');
    } finally {
      setAddingFriend(false);
    }
  };

  const avatarBg = member.isAdmin ? colors.accentMuted : colors.card;
  const avatarTextColor = member.isAdmin ? colors.accent : colors.textMuted;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <TouchableOpacity
        style={styles.overlay}
        activeOpacity={1}
        onPress={onClose}
        accessible={false}
      />

      <View style={styles.sheet}>
        {/* Drag handle */}
        <View style={styles.handle} />

        {/* Avatar */}
        <View style={[styles.avatar, { backgroundColor: avatarBg }]}>
          <Text style={[styles.avatarText, { color: avatarTextColor }]}>{initials(member.displayName)}</Text>
        </View>

        {/* Name */}
        <Text style={styles.name} numberOfLines={1}>{member.displayName}</Text>

        {/* Callsign badge */}
        <View style={styles.callsignBadge}>
          <Ionicons name="radio-outline" size={13} color={colors.textMuted} style={styles.callsignIcon} />
          <Text style={styles.callsignText}>
            {member.callsign ?? 'No callsign'}
          </Text>
        </View>

        {/* Online status */}
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, { backgroundColor: member.isOnline ? colors.success : colors.textSubtle }]} />
          <Text style={[styles.status, { color: member.isOnline ? colors.success : colors.textSubtle }]}>
            {member.isOnline ? 'Online' : 'Offline'}
          </Text>
        </View>

        {/* Stats row */}
        <View style={styles.statsRow}>
          {member.speedKph !== undefined && (
            <View style={styles.statPill}>
              <Ionicons name="speedometer-outline" size={13} color={colors.text} />
              <Text style={styles.statText}>{Math.round(member.speedKph)} km/h</Text>
            </View>
          )}
          {member.distanceM !== undefined && (
            <View style={styles.statPill}>
              <Ionicons name="navigate-outline" size={13} color={colors.text} />
              <Text style={styles.statText}>{formatDistance(member.distanceM)} behind</Text>
            </View>
          )}
          {member.isMuted && (
            <View style={[styles.statPill, styles.mutedPill]}>
              <Ionicons name="volume-mute-outline" size={13} color={colors.text} />
              <Text style={styles.statText}>Muted</Text>
            </View>
          )}
        </View>

        {/* Social actions */}
        <View style={styles.socialRow}>
          {activeGroupId && (
            <TouchableOpacity
              style={[styles.inviteBtn, inviting && styles.inviteBtnDisabled]}
              onPress={handleInviteToConvoy}
              disabled={inviting}
              accessibilityRole="button"
              accessibilityLabel="Invite to convoy"
              accessibilityState={{ disabled: inviting, busy: inviting }}
            >
              {inviting ? (
                <ActivityIndicator color={colors.accent} size="small" />
              ) : (
                <>
                  <Ionicons name="paper-plane-outline" size={15} color={colors.accent} style={styles.btnIcon} />
                  <Text style={styles.inviteBtnText}>Invite to Convoy</Text>
                </>
              )}
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.addFriendBtn, friendSent && styles.addFriendSent]}
            onPress={handleAddFriend}
            disabled={friendSent || addingFriend}
            accessibilityRole="button"
            accessibilityLabel={friendSent ? 'Friend request sent' : 'Add friend'}
            accessibilityState={{ disabled: friendSent || addingFriend, busy: addingFriend }}
          >
            {addingFriend ? (
              <ActivityIndicator color={colors.text} size="small" />
            ) : (
              <>
                <Ionicons
                  name={friendSent ? 'checkmark-circle' : 'person-add-outline'}
                  size={15}
                  color={friendSent ? colors.success : colors.text}
                  style={styles.btnIcon}
                />
                <Text style={styles.addFriendText}>
                  {friendSent ? 'Request Sent' : 'Add Friend'}
                </Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.viewProfileBtn}
            onPress={() => { onClose(); (router.push as (href: string) => void)(`/profile/${member.userId}`); }}
            accessibilityRole="button"
            accessibilityLabel="View full profile"
          >
            <Text style={styles.viewProfileText}>View Profile</Text>
          </TouchableOpacity>
        </View>

        {/* Admin controls */}
        {showAdminControls && (
          <View style={styles.adminSection}>
            <View style={styles.adminRow}>
              <TouchableOpacity
                style={[styles.outlineBtn, muting && styles.outlineBtnDisabled]}
                onPress={async () => {
                  if (!activeGroupId || muting) return;
                  setMuting(true);
                  try {
                    await apiClient.post(
                      `/api/v1/groups/${activeGroupId}/members/${member.userId}/mute`,
                      { muted: !member.isMuted },
                    );
                    onMute?.(member.userId, !member.isMuted);
                  } catch {
                    Alert.alert('Error', 'Could not update mute status. Try again.');
                  } finally {
                    setMuting(false);
                  }
                }}
                disabled={muting}
                accessibilityRole="button"
                accessibilityLabel={member.isMuted ? 'Unmute' : 'Mute'}
                accessibilityState={{ disabled: muting, busy: muting }}
              >
                {muting ? (
                  <ActivityIndicator color={colors.text} size="small" />
                ) : (
                  <>
                    <Ionicons
                      name={member.isMuted ? 'volume-high-outline' : 'volume-mute-outline'}
                      size={15}
                      color={colors.text}
                      style={styles.btnIcon}
                    />
                    <Text style={styles.outlineBtnText}>{member.isMuted ? 'Unmute' : 'Mute'}</Text>
                  </>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.outlineBtn}
                onPress={() => { onNavigateTo?.(member.userId); onClose(); }}
                accessibilityRole="button"
                accessibilityLabel="Navigate to member"
              >
                <Ionicons name="navigate-outline" size={15} color={colors.text} style={styles.btnIcon} />
                <Text style={styles.outlineBtnText}>Navigate to</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={[styles.kickBtn, kicking && styles.kickBtnDisabled]}
              disabled={kicking}
              onPress={() => {
                Alert.alert(
                  'Remove Member',
                  `Remove ${member.displayName} from the group?`,
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Remove',
                      style: 'destructive',
                      onPress: async () => {
                        if (!activeGroupId) return;
                        setKicking(true);
                        try {
                          await apiClient.delete(
                            `/api/v1/groups/${activeGroupId}/members/${member.userId}`,
                          );
                          onKick?.(member.userId);
                          onClose();
                        } catch {
                          Alert.alert('Error', 'Could not remove member. Try again.');
                        } finally {
                          setKicking(false);
                        }
                      },
                    },
                  ],
                );
              }}
              accessibilityRole="button"
              accessibilityLabel="Remove from group"
              accessibilityState={{ disabled: kicking, busy: kicking }}
            >
              {kicking
                ? <ActivityIndicator color={colors.accent} size="small" />
                : <Text style={styles.kickBtnText}>Remove from group</Text>}
            </TouchableOpacity>
          </View>
        )}

        {/* Close */}
        <TouchableOpacity style={styles.closeBtn} onPress={onClose} accessibilityRole="button">
          <Text style={styles.closeBtnText}>Close</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.cardElevated,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 36,
    alignItems: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 8,
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: colors.border,
    borderRadius: 2,
    marginBottom: 20,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  avatarText: {
    fontSize: 22,
    fontWeight: '700',
  },
  name: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 8,
    textAlign: 'center',
  },
  callsignBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bg,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginBottom: 10,
  },
  callsignIcon: {
    marginRight: 5,
  },
  callsignText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 16,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  status: {
    fontSize: 14,
    fontWeight: '600',
  },
  statsRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
    justifyContent: 'center',
    marginBottom: 20,
  },
  statPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.bg,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  mutedPill: {
    borderColor: colors.accent,
  },
  statText: {
    color: colors.text,
    fontSize: 13,
  },
  adminSection: {
    width: '100%',
    gap: 10,
    marginBottom: 16,
  },
  adminRow: {
    flexDirection: 'row',
    gap: 10,
  },
  outlineBtn: {
    flex: 1,
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  btnIcon: {
    marginRight: 6,
  },
  outlineBtnText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  kickBtn: {
    width: '100%',
    paddingVertical: 12,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  kickBtnDisabled: {
    opacity: 0.5,
  },
  kickBtnText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '600',
  },
  outlineBtnDisabled: {
    opacity: 0.5,
  },
  closeBtn: {
    width: '100%',
    backgroundColor: colors.bg,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 44,
    justifyContent: 'center',
  },
  closeBtnText: {
    color: colors.textMuted,
    fontSize: 15,
    fontWeight: '600',
  },
  socialRow: {
    width: '100%',
    gap: 10,
    marginBottom: 16,
  },
  inviteBtn: {
    width: '100%',
    flexDirection: 'row',
    borderWidth: 1.5,
    borderColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  inviteBtnDisabled: {
    opacity: 0.5,
  },
  inviteBtnText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '700',
  },
  addFriendBtn: {
    width: '100%',
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  addFriendSent: {
    borderColor: colors.success,
    opacity: 0.7,
  },
  addFriendText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  viewProfileBtn: {
    width: '100%',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  viewProfileText: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '600',
  },
  });
}
