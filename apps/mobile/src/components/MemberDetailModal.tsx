import React, { useState } from 'react';
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
import { useGroupStore } from '../stores/groupStore';
import { apiClient } from '../services/apiClient';

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
  const activeGroupId = useGroupStore((s) => s.activeGroupId);
  const [friendSent, setFriendSent] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [kicking, setKicking] = useState(false);
  const [muting, setMuting] = useState(false);

  if (!member) return null;

  const showAdminControls = isCurrentUserAdmin;

  const handleInviteToConvoy = async () => {
    if (!activeGroupId) return;
    setInviting(true);
    try {
      const res = await fetch(`/api/v1/groups/${activeGroupId}/invite-link`);
      const { code, link } = await res.json() as { code: string; link: string };
      await Share.share({
        message: `Join my convoy on CONVOY! Code: ${code}\n${link}`,
      });
    } catch {
      Alert.alert('Error', 'Could not get invite link. Try again.');
    } finally {
      setInviting(false);
    }
  };

  const handleAddFriend = async () => {
    try {
      await fetch('/api/v1/friends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: member.userId }),
      });
      setFriendSent(true);
    } catch {
      Alert.alert('Error', 'Could not send friend request.');
    }
  };

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
      />

      <View style={styles.sheet}>
        {/* Drag handle */}
        <View style={styles.handle} />

        {/* Avatar */}
        <View style={[styles.avatar, { backgroundColor: member.isAdmin ? '#DC143C' : '#1C1C1C' }]}>
          <Text style={styles.avatarText}>{initials(member.displayName)}</Text>
        </View>

        {/* Name */}
        <Text style={styles.name} numberOfLines={1}>{member.displayName}</Text>

        {/* Callsign badge */}
        <View style={styles.callsignBadge}>
          <Text style={styles.callsignText}>
            {member.callsign ? `📻 ${member.callsign}` : 'No callsign'}
          </Text>
        </View>

        {/* Online status */}
        <Text style={[styles.status, { color: member.isOnline ? '#22C55E' : '#555555' }]}>
          {member.isOnline ? '🟢 Online' : '⚫ Offline'}
        </Text>

        {/* Stats row */}
        <View style={styles.statsRow}>
          {member.speedKph !== undefined && (
            <View style={styles.statPill}>
              <Text style={styles.statText}>🚗 {Math.round(member.speedKph)} km/h</Text>
            </View>
          )}
          {member.distanceM !== undefined && (
            <View style={styles.statPill}>
              <Text style={styles.statText}>📏 {formatDistance(member.distanceM)} behind</Text>
            </View>
          )}
          {member.isMuted && (
            <View style={[styles.statPill, styles.mutedPill]}>
              <Text style={styles.statText}>🔇 Muted</Text>
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
            >
              <Text style={styles.inviteBtnText}>
                {inviting ? 'Getting link...' : '📨 Invite to Convoy'}
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.addFriendBtn, friendSent && styles.addFriendSent]}
            onPress={handleAddFriend}
            disabled={friendSent}
            accessibilityRole="button"
            accessibilityLabel={friendSent ? 'Friend request sent' : 'Add friend'}
          >
            <Text style={styles.addFriendText}>
              {friendSent ? '✓ Request Sent' : '🤝 Add Friend'}
            </Text>
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
              >
                {muting
                  ? <ActivityIndicator color="#FFFFFF" size="small" />
                  : <Text style={styles.outlineBtnText}>{member.isMuted ? '🔊 Unmute' : '🔇 Mute'}</Text>}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.outlineBtn}
                onPress={() => { onNavigateTo?.(member.userId); onClose(); }}
                accessibilityRole="button"
              >
                <Text style={styles.outlineBtnText}>🗺️ Navigate to</Text>
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
            >
              {kicking
                ? <ActivityIndicator color="#DC143C" size="small" />
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

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#1C1C1C',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 36,
    alignItems: 'center',
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: '#3A3A3A',
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
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '700',
  },
  name: {
    fontSize: 20,
    fontWeight: '700',
    color: '#FFFFFF',
    marginBottom: 8,
    textAlign: 'center',
  },
  callsignBadge: {
    backgroundColor: '#0A0A0A',
    borderRadius: 100,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginBottom: 10,
  },
  callsignText: {
    color: '#888888',
    fontSize: 13,
    fontWeight: '600',
  },
  status: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 16,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
    justifyContent: 'center',
    marginBottom: 20,
  },
  statPill: {
    backgroundColor: '#0A0A0A',
    borderRadius: 100,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  mutedPill: {
    borderColor: '#DC143C',
  },
  statText: {
    color: '#FFFFFF',
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
    borderWidth: 1,
    borderColor: '#2A2A2A',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  outlineBtnText: {
    color: '#FFFFFF',
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
    color: '#DC143C',
    fontSize: 14,
    fontWeight: '600',
  },
  outlineBtnDisabled: {
    opacity: 0.5,
  },
  closeBtn: {
    width: '100%',
    backgroundColor: '#0A0A0A',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  closeBtnText: {
    color: '#888888',
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
    borderWidth: 1.5,
    borderColor: '#DC143C',
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
  },
  inviteBtnDisabled: {
    opacity: 0.5,
  },
  inviteBtnText: {
    color: '#DC143C',
    fontSize: 15,
    fontWeight: '700',
  },
  addFriendBtn: {
    width: '100%',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  addFriendSent: {
    borderColor: '#22C55E',
    opacity: 0.7,
  },
  addFriendText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  viewProfileBtn: {
    width: '100%',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  viewProfileText: {
    color: '#888888',
    fontSize: 14,
    fontWeight: '600',
  },
});
