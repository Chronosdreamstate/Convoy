import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Share,
  Alert,
  ActivityIndicator,
  Image,
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

/** Active-vehicle summary returned by GET /api/v1/vehicles/active/:userId (Req 29.4/29.5). */
interface MemberVehicle {
  id: string;
  name: string | null;
  type: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  color: string | null;
  photoUrl: string | null;
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

/** "5 min" / "1 h 20 min" — mirrors the backend's route durationText format. */
function formatEta(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 1) return '<1 min';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

// Vehicle colour is free text ("Midnight Blue", "red", ...). Resolve common
// colour words to a renderable swatch hex; unknown colours render text-only.
const SWATCH_COLORS: Record<string, string> = {
  black: '#1A1A1A', white: '#F5F5F5', silver: '#C0C0C0', grey: '#808080',
  gray: '#808080', red: '#C62828', blue: '#1565C0', green: '#2E7D32',
  yellow: '#F9A825', orange: '#EF6C00', purple: '#6A1B9A', brown: '#5D4037',
  gold: '#C9A227', beige: '#D7C4A3', tan: '#D2B48C', maroon: '#800000',
};
function swatchColor(color: string): string | null {
  const key = color.trim().toLowerCase();
  if (SWATCH_COLORS[key]) return SWATCH_COLORS[key];
  // "Midnight Blue" -> "blue"
  const lastWord = key.split(/\s+/).pop() ?? '';
  return SWATCH_COLORS[lastWord] ?? null;
}

/** "2021 Subaru WRX", falling back to the vehicle's nickname when unlabelled. */
function vehicleTitle(v: MemberVehicle): string {
  const parts = [v.year, v.make, v.model].filter(Boolean).join(' ');
  return parts || v.name || 'Vehicle';
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
  const [friendStatus, setFriendStatus] = useState<string | null>(null);
  const [friendDirection, setFriendDirection] = useState<'outgoing' | 'incoming' | null>(null);
  const [inviting, setInviting] = useState(false);
  const [kicking, setKicking] = useState(false);
  const [muting, setMuting] = useState(false);
  const [vehicle, setVehicle] = useState<MemberVehicle | null>(null);
  const [vehicleLoading, setVehicleLoading] = useState(false);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);

  // Fetch the member's active vehicle when the sheet opens (Req 29.4/29.5).
  // The vehicle is static garage data, so it's pulled on demand rather than
  // carried in the live location/presence stream. Any failure (including
  // 403 for non-groupmates) degrades to the "No vehicle set" state (Req 29.6).
  const memberUserId = member?.userId;
  useEffect(() => {
    if (!visible || !memberUserId) {
      setVehicle(null);
      setVehicleLoading(false);
      return;
    }
    let cancelled = false;
    setVehicleLoading(true);
    apiClient
      .get<{ vehicle: MemberVehicle | null }>(`/api/v1/vehicles/active/${memberUserId}`)
      .then((res) => { if (!cancelled) setVehicle(res.data.vehicle); })
      .catch(() => { if (!cancelled) setVehicle(null); })
      .finally(() => { if (!cancelled) setVehicleLoading(false); });
    return () => { cancelled = true; };
  }, [visible, memberUserId]);

  // Fetch the member's ETA to the shared destination when the sheet opens
  // (Req 8.5). Computed server-side from the same cached destination and live
  // fix every client sees, so all viewers read a synchronized value — the
  // same fetch-on-open pattern as the vehicle card above. No pushed route,
  // no live fix, a stationary member, or any fetch failure all resolve to
  // null, which simply omits the ETA pill.
  useEffect(() => {
    if (!visible || !memberUserId || !activeGroupId) {
      setEtaSeconds(null);
      return;
    }
    let cancelled = false;
    apiClient
      .get<{ etaSeconds: number | null }>(`/api/v1/groups/${activeGroupId}/members/${memberUserId}/eta`)
      .then((res) => { if (!cancelled) setEtaSeconds(res.data.etaSeconds ?? null); })
      .catch(() => { if (!cancelled) setEtaSeconds(null); });
    return () => { cancelled = true; };
  }, [visible, memberUserId, activeGroupId]);

  // Friend state when the sheet opens — without this the modal offered "Add
  // Friend" to existing friends and to members with a request already pending
  // in EITHER direction, and the POST just failed with a generic error. Uses
  // the same GET /users/:id fields as UserProfileScreen (friendStatus +
  // friendRequestDirection). Failure degrades to the old optimistic button.
  useEffect(() => {
    if (!visible || !memberUserId) {
      setFriendStatus(null);
      setFriendDirection(null);
      setFriendSent(false);
      return;
    }
    let cancelled = false;
    apiClient
      .get<{ friendStatus: string | null; friendRequestDirection?: 'outgoing' | 'incoming' | null }>(
        `/api/v1/users/${memberUserId}`,
      )
      .then((res) => {
        if (cancelled) return;
        setFriendStatus(res.data.friendStatus);
        setFriendDirection(res.data.friendRequestDirection ?? null);
      })
      .catch(() => { /* degrade to the optimistic Add Friend button */ });
    return () => { cancelled = true; };
  }, [visible, memberUserId]);

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

  // Friend-button state derived from the fetched relationship (Req 30.1):
  //   accepted            → "Friends" (settled, disabled)
  //   pending outgoing    → "Request Sent" (disabled; withdraw lives on the profile)
  //   pending incoming    → "Respond to Request" → opens the full profile,
  //                         where Accept/Decline live — the modal must not
  //                         fire a duplicate outgoing request at someone
  //                         already waiting on YOUR answer
  //   none / fetch failed → "Add Friend" (the original optimistic behavior)
  const isIncomingPending = friendStatus === 'pending' && friendDirection === 'incoming';
  const friendSettled = friendStatus === 'accepted' || friendSent
    || (friendStatus === 'pending' && friendDirection !== 'incoming');
  const friendBtnLabel = friendStatus === 'accepted'
    ? 'Friends'
    : isIncomingPending
      ? 'Respond to Request'
      : friendSettled
        ? 'Request Sent'
        : 'Add Friend';
  const openFullProfile = () => {
    onClose();
    (router.push as (href: string) => void)(`/profile/${member.userId}`);
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
          {etaSeconds != null && (
            <View style={styles.statPill} testID="member-eta-pill">
              <Ionicons name="time-outline" size={13} color={colors.text} />
              <Text style={styles.statText}>ETA {formatEta(etaSeconds)}</Text>
            </View>
          )}
          {member.isMuted && (
            <View style={[styles.statPill, styles.mutedPill]}>
              <Ionicons name="volume-mute-outline" size={13} color={colors.text} />
              <Text style={styles.statText}>Muted</Text>
            </View>
          )}
        </View>

        {/* Active vehicle (Req 29.4, 29.5, 29.6) */}
        <View style={styles.vehicleCard} testID="member-vehicle-card">
          {vehicleLoading ? (
            <ActivityIndicator color={colors.textMuted} size="small" testID="member-vehicle-loading" />
          ) : vehicle ? (
            <>
              {vehicle.photoUrl && (
                <Image
                  source={{ uri: vehicle.photoUrl }}
                  style={styles.vehiclePhoto}
                  resizeMode="cover"
                  accessibilityLabel={`Photo of ${vehicleTitle(vehicle)}`}
                  testID="member-vehicle-photo"
                />
              )}
              <View style={styles.vehicleTitleRow}>
                <Ionicons name="car-sport-outline" size={15} color={colors.text} />
                <Text style={styles.vehicleTitle} numberOfLines={1}>{vehicleTitle(vehicle)}</Text>
              </View>
              {vehicle.color != null && vehicle.color !== '' && (
                <View style={styles.vehicleColorRow}>
                  {swatchColor(vehicle.color) && (
                    <View
                      style={[styles.colorSwatch, { backgroundColor: swatchColor(vehicle.color)! }]}
                      testID="member-vehicle-swatch"
                    />
                  )}
                  <Text style={styles.vehicleColorText}>{vehicle.color}</Text>
                </View>
              )}
            </>
          ) : (
            <Text style={styles.noVehicleText}>No vehicle set</Text>
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
            style={[styles.addFriendBtn, friendSettled && styles.addFriendSent]}
            onPress={isIncomingPending ? openFullProfile : handleAddFriend}
            disabled={friendSettled || addingFriend}
            accessibilityRole="button"
            accessibilityLabel={friendBtnLabel}
            accessibilityState={{ disabled: friendSettled || addingFriend, busy: addingFriend }}
          >
            {addingFriend ? (
              <ActivityIndicator color={colors.text} size="small" />
            ) : (
              <>
                <Ionicons
                  name={
                    friendStatus === 'accepted' || friendSent
                      ? 'checkmark-circle'
                      : isIncomingPending
                        ? 'mail-unread-outline'
                        : friendSettled
                          ? 'time-outline'
                          : 'person-add-outline'
                  }
                  size={15}
                  color={friendStatus === 'accepted' || friendSent ? colors.success : colors.text}
                  style={styles.btnIcon}
                />
                <Text style={styles.addFriendText}>{friendBtnLabel}</Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.viewProfileBtn}
            onPress={openFullProfile}
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
  vehicleCard: {
    width: '100%',
    backgroundColor: colors.bg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    alignItems: 'center',
    gap: 6,
    marginBottom: 16,
  },
  vehiclePhoto: {
    width: '100%',
    height: 120,
    borderRadius: 8,
    backgroundColor: colors.card,
  },
  vehicleTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
  },
  vehicleTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
    flexShrink: 1,
  },
  vehicleColorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  colorSwatch: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  vehicleColorText: {
    color: colors.textMuted,
    fontSize: 13,
  },
  noVehicleText: {
    color: colors.textSubtle,
    fontSize: 13,
    fontWeight: '600',
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
