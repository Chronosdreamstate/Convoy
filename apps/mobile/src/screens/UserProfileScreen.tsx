import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { apiClient } from '../services/apiClient';
import { SkeletonBox } from '../components/SkeletonLoader';
import { NetworkError } from '../components/NetworkError';
import { ThemeColors, useTheme } from '../theme';

// Text/icons that always sit on the crimson accent fill (Add Friend button) —
// stays light in both themes. `colors.text` is near-black in light mode, which
// would be unreadable on the accent background.
const ON_ACCENT = '#FFFFFF';

interface UserProfile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  callsign: string | null;
  bio: string | null;
  memberSince: string;
  vehicleType: string | null;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleYear: number | null;
  vehicleColor: string | null;
  mods: string[];
  totalDrives: number;
  totalDistanceKm: number;
  mutualFriends: number;
  friendStatus: string | null;
  // Additive fields (may be absent on older API builds): direction of a
  // pending request and the friendships row id the request endpoints key on.
  friendRequestDirection?: 'outgoing' | 'incoming' | null;
  friendRequestId?: string | null;
}

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}

function memberYear(iso: string): string {
  return new Date(iso).getFullYear().toString();
}

function vehicleLabel(p: UserProfile): string {
  const parts = [p.vehicleYear, p.vehicleMake, p.vehicleModel].filter(Boolean);
  return parts.join(' ') || p.vehicleType || 'No vehicle listed';
}

export default function UserProfileScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [friendStatus, setFriendStatus] = useState<string | null>(null);
  const [requestDirection, setRequestDirection] = useState<'outgoing' | 'incoming' | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [friendLoading, setFriendLoading] = useState(false);
  const [blocking, setBlocking] = useState(false);

  const fadeAnim = React.useRef(new Animated.Value(0)).current;

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.get<UserProfile>(`/api/v1/users/${userId}`);
      setProfile(res.data);
      setFriendStatus(res.data.friendStatus);
      setRequestDirection(res.data.friendRequestDirection ?? null);
      setRequestId(res.data.friendRequestId ?? null);
      Animated.timing(fadeAnim, { toValue: 1, duration: 340, useNativeDriver: true }).start();
    } catch {
      setError('Could not load profile.');
    } finally {
      setLoading(false);
    }
  }, [userId, fadeAnim]);

  useEffect(() => { void load(); }, [load]);

  const handleAddFriend = async () => {
    if (!profile || friendLoading) return;
    setFriendLoading(true);
    try {
      const res = await apiClient.post<{ id?: string; status?: string; autoAccepted?: boolean }>(
        '/api/v1/friends/requests',
        { addresseeId: profile.id },
      );
      // Open-privacy accounts auto-accept (server returns status 'accepted').
      if (res.data?.status === 'accepted' || res.data?.autoAccepted) {
        setFriendStatus('accepted');
        setRequestDirection(null);
        setRequestId(null);
      } else {
        setFriendStatus('pending');
        setRequestDirection('outgoing');
        setRequestId(res.data?.id ?? null);
      }
    } catch {
      Alert.alert('Error', 'Could not send friend request. Please try again.');
    } finally {
      setFriendLoading(false);
    }
  };

  // Withdraw a pending request the viewer sent (DELETE /friends/requests/:id).
  const handleWithdraw = () => {
    if (!profile || !requestId || friendLoading) return;
    Alert.alert(
      'Withdraw Request',
      `Withdraw your friend request to ${profile.displayName}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Withdraw',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setFriendLoading(true);
              try {
                await apiClient.delete(`/api/v1/friends/requests/${requestId}`);
                setFriendStatus(null);
                setRequestDirection(null);
                setRequestId(null);
              } catch {
                Alert.alert('Error', 'Could not withdraw the request. Please try again.');
              } finally {
                setFriendLoading(false);
              }
            })();
          },
        },
      ],
    );
  };

  // Accept / decline a pending request this user sent to the viewer.
  const handleRespond = async (action: 'accept' | 'decline') => {
    if (!requestId || friendLoading) return;
    setFriendLoading(true);
    try {
      await apiClient.post(`/api/v1/friends/requests/${requestId}/${action}`);
      setFriendStatus(action === 'accept' ? 'accepted' : null);
      setRequestDirection(null);
      setRequestId(null);
    } catch {
      Alert.alert(
        'Error',
        action === 'accept'
          ? 'Could not accept the request. Please try again.'
          : 'Could not decline the request. Please try again.',
      );
    } finally {
      setFriendLoading(false);
    }
  };

  const handleShare = async () => {
    if (!profile) return;
    await Share.share({ message: `Check out ${profile.displayName} on CORTEGE!` }).catch(() => {});
  };

  const handleBlock = () => {
    if (!profile || blocking) return;
    Alert.alert(
      'Block User',
      `Block ${profile.displayName}? They won't be able to send you friend requests or see your location, and any existing friendship will be removed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setBlocking(true);
              try {
                await apiClient.post('/api/v1/friends/block', { userId: profile.id });
                // Blocking wipes any friendship/pending request server-side —
                // reflect the new relationship locally so the screen shows the
                // Blocked state (with Unblock) if the user stays on it.
                setFriendStatus('blocked');
                setRequestDirection(null);
                setRequestId(null);
                Alert.alert('User Blocked', `${profile.displayName} has been blocked.`, [
                  { text: 'OK', onPress: () => router.back() },
                ]);
              } catch {
                Alert.alert('Error', 'Could not block this user. Please try again.');
              } finally {
                setBlocking(false);
              }
            })();
          },
        },
      ],
    );
  };

  const handleUnblock = async () => {
    if (!profile || blocking) return;
    setBlocking(true);
    try {
      await apiClient.post('/api/v1/friends/unblock', { userId: profile.id });
      setFriendStatus(null);
      setRequestDirection(null);
      setRequestId(null);
    } catch {
      Alert.alert('Error', 'Could not unblock this user. Please try again.');
    } finally {
      setBlocking(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Profile</Text>
          <View style={styles.backBtn} />
        </View>
        <View style={styles.skeletonWrap}>
          <View style={styles.skeletonHeroCard}>
            <SkeletonBox width={80} height={80} borderRadius={40} />
            <SkeletonBox width="50%" height={22} />
            <SkeletonBox width="35%" height={14} />
            <SkeletonBox width="90%" height={40} />
          </View>
          <View style={styles.skeletonStatsCard}>
            <SkeletonBox width="30%" height={28} />
            <View style={styles.statDivider} />
            <SkeletonBox width="30%" height={28} />
          </View>
          <View style={{ marginHorizontal: 16, marginTop: 20, gap: 10 }}>
            <SkeletonBox width="20%" height={11} />
            <SkeletonBox width="100%" height={72} borderRadius={16} />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (error || !profile) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Profile</Text>
          <View style={styles.backBtn} />
        </View>
        <NetworkError onRetry={() => void load()} message={error ?? 'User not found.'} />
      </SafeAreaView>
    );
  }

  const isPending = friendStatus === 'pending';
  // Direction comes from the API's friendRequestDirection field; requestId is
  // the friendships row id the accept/decline/withdraw endpoints key on. A
  // pending status with no direction (older API build) falls back to the
  // legacy disabled "Request Sent" state.
  const isOutgoing = isPending && requestDirection === 'outgoing' && requestId !== null;
  const isIncoming = isPending && requestDirection === 'incoming' && requestId !== null;

  const friendBtnLabel = isOutgoing
    ? 'Requested'
    : isPending
    ? 'Request Sent'
    : friendStatus === 'accepted'
    ? 'Friends'
    : 'Add Friend';
  const friendBtnIcon = isPending
    ? 'time-outline'
    : friendStatus === 'accepted'
    ? 'checkmark-circle'
    : 'person-add-outline';
  // Outgoing requests keep the muted "done" styling but stay tappable so the
  // viewer can withdraw; accepted and direction-less pending stay disabled.
  const friendBtnMuted = isPending || friendStatus === 'accepted';
  const friendBtnDisabled = (isPending && !isOutgoing) || friendStatus === 'accepted' || friendLoading;

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      {/* Header bar */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Profile</Text>
        <TouchableOpacity
          style={styles.shareBtn}
          onPress={() => void handleShare()}
          accessibilityRole="button"
          accessibilityLabel="Share profile"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="share-social-outline" size={20} color={colors.accent} />
        </TouchableOpacity>
      </View>

      <Animated.ScrollView style={{ opacity: fadeAnim }} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Hero card */}
        <View style={styles.heroCard}>
          <View style={[styles.avatar, { backgroundColor: colors.accent }]}>
            <Text style={styles.avatarText}>{initials(profile.displayName)}</Text>
          </View>

          <Text style={styles.name}>{profile.displayName}</Text>

          {profile.callsign && (
            <View style={styles.callsignBadge}>
              <Ionicons name="radio-outline" size={12} color={colors.textMuted} style={styles.callsignIcon} />
              <Text style={styles.callsignText}>{profile.callsign}</Text>
            </View>
          )}

          {profile.mutualFriends > 0 && (
            <Text style={styles.mutualText}>
              {profile.mutualFriends} mutual {profile.mutualFriends === 1 ? 'friend' : 'friends'}
            </Text>
          )}

          {profile.bio ? <Text style={styles.bio}>{profile.bio}</Text> : null}

          <Text style={styles.memberSince}>Member since {memberYear(profile.memberSince)}</Text>

          {/* Action buttons — a user the viewer has blocked gets an honest
              Blocked state with Unblock, never a dead "Add Friend" button
              (the server rejects friend requests across a block, Req 17.11). */}
          {friendStatus === 'blocked' ? (
            <View style={styles.actionRow}>
              <Text style={styles.blockedNotice}>
                You've blocked this user. They can't send you friend requests or see your location.
              </Text>
              <TouchableOpacity
                style={styles.blockBtn}
                onPress={() => void handleUnblock()}
                disabled={blocking}
                accessibilityRole="button"
                accessibilityLabel={`Unblock ${profile.displayName}`}
                accessibilityState={{ disabled: blocking }}
              >
                {blocking ? (
                  <ActivityIndicator color={colors.accent} size="small" />
                ) : (
                  <>
                    <Ionicons name="ban-outline" size={16} color={colors.accent} style={styles.friendBtnIcon} />
                    <Text style={styles.blockBtnText}>Unblock</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          ) : (
          <View style={styles.actionRow}>
            {isIncoming ? (
              <>
                <Text style={styles.incomingNotice}>
                  {profile.displayName} sent you a friend request.
                </Text>
                <View style={styles.respondRow}>
                  <TouchableOpacity
                    style={[styles.friendBtn, styles.respondHalf]}
                    onPress={() => void handleRespond('accept')}
                    disabled={friendLoading}
                    accessibilityRole="button"
                    accessibilityLabel="Accept friend request"
                    accessibilityState={{ disabled: friendLoading }}
                  >
                    {friendLoading ? (
                      <ActivityIndicator color={ON_ACCENT} size="small" />
                    ) : (
                      <>
                        <Ionicons name="checkmark" size={16} color={ON_ACCENT} style={styles.friendBtnIcon} />
                        <Text style={styles.friendBtnText}>Accept</Text>
                      </>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.declineBtn, styles.respondHalf]}
                    onPress={() => void handleRespond('decline')}
                    disabled={friendLoading}
                    accessibilityRole="button"
                    accessibilityLabel="Decline friend request"
                    accessibilityState={{ disabled: friendLoading }}
                  >
                    <Ionicons name="close" size={16} color={colors.textMuted} style={styles.friendBtnIcon} />
                    <Text style={styles.declineBtnText}>Decline</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : (
            <TouchableOpacity
              style={[styles.friendBtn, friendBtnMuted && styles.friendBtnDone]}
              onPress={isOutgoing ? handleWithdraw : () => void handleAddFriend()}
              disabled={friendBtnDisabled}
              accessibilityRole="button"
              accessibilityLabel={friendLoading ? 'Sending friend request' : friendBtnLabel}
              accessibilityHint={isOutgoing ? 'Withdraws your pending friend request' : undefined}
              accessibilityState={{ disabled: friendBtnDisabled }}
            >
              {friendLoading ? (
                <ActivityIndicator color={friendBtnMuted ? colors.textMuted : ON_ACCENT} size="small" />
              ) : (
                <>
                  <Ionicons
                    name={friendBtnIcon as never}
                    size={16}
                    color={friendBtnMuted ? colors.textMuted : ON_ACCENT}
                    style={styles.friendBtnIcon}
                  />
                  <Text style={[styles.friendBtnText, friendBtnMuted && styles.friendBtnTextDone]}>
                    {friendBtnLabel}
                  </Text>
                </>
              )}
            </TouchableOpacity>
            )}

            <TouchableOpacity
              style={styles.blockBtn}
              onPress={handleBlock}
              disabled={blocking}
              accessibilityRole="button"
              accessibilityLabel={`Block ${profile.displayName}`}
              accessibilityState={{ disabled: blocking }}
            >
              {blocking ? (
                <ActivityIndicator color={colors.accent} size="small" />
              ) : (
                <>
                  <Ionicons name="ban-outline" size={16} color={colors.accent} style={styles.friendBtnIcon} />
                  <Text style={styles.blockBtnText}>Block</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
          )}
        </View>

        {/* Stats row */}
        <View style={styles.statsCard}>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{profile.totalDrives}</Text>
            <Text style={styles.statLabel}>Drives</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{profile.totalDistanceKm.toLocaleString()}</Text>
            <Text style={styles.statLabel}>km driven</Text>
          </View>
        </View>

        {/* Vehicle card */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>RIDE</Text>
          <View style={styles.vehicleCard}>
            <View style={styles.vehicleIconBg}>
              <Ionicons name="car-sport-outline" size={22} color={colors.textMuted} />
            </View>
            <View style={styles.vehicleInfo}>
              <Text style={styles.vehicleLabel}>{vehicleLabel(profile)}</Text>
              {profile.vehicleColor && (
                <Text style={styles.vehicleColor}>{profile.vehicleColor}</Text>
              )}
            </View>
          </View>

          {/* Mods list */}
          {profile.mods.length > 0 && (
            <View style={styles.modsWrap}>
              {profile.mods.map((mod, i) => (
                <View key={i} style={styles.modChip}>
                  <Text style={styles.modText}>{mod}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      </Animated.ScrollView>
    </SafeAreaView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    scroll: { paddingBottom: 40 },
    skeletonWrap: { flex: 1 },
    skeletonHeroCard: {
      backgroundColor: colors.card, marginHorizontal: 16, marginTop: 20,
      borderRadius: 20, padding: 24, alignItems: 'center', gap: 12,
      borderWidth: 1, borderColor: colors.border,
    },
    skeletonStatsCard: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around',
      backgroundColor: colors.card, marginHorizontal: 16, marginTop: 12,
      borderRadius: 16, paddingVertical: 20, borderWidth: 1, borderColor: colors.border,
    },

    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    headerTitle: { color: colors.text, fontSize: 16, fontWeight: '700', letterSpacing: 0.5 },
    shareBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },

    heroCard: {
      backgroundColor: colors.card,
      marginHorizontal: 16,
      marginTop: 20,
      borderRadius: 20,
      padding: 24,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
    },
    avatar: {
      width: 80,
      height: 80,
      borderRadius: 40,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 14,
    },
    avatarText: { color: '#FFFFFF', fontSize: 28, fontWeight: '800' },
    name: { color: colors.text, fontSize: 22, fontWeight: '800', marginBottom: 8, textAlign: 'center' },
    callsignBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.bg,
      borderRadius: 100,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 14,
      paddingVertical: 5,
      marginBottom: 8,
    },
    callsignIcon: { marginRight: 5 },
    callsignText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
    mutualText: { color: colors.textMuted, fontSize: 13, marginBottom: 8 },
    bio: { color: colors.text, fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 8 },
    memberSince: { color: colors.textSubtle, fontSize: 12, marginBottom: 16 },

    actionRow: { width: '100%', gap: 10 },
    friendBtn: {
      flexDirection: 'row',
      width: '100%',
      backgroundColor: colors.accent,
      borderRadius: 12,
      paddingVertical: 14,
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 48,
    },
    friendBtnDone: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
    friendBtnIcon: { marginRight: 8 },
    friendBtnText: { color: ON_ACCENT, fontSize: 15, fontWeight: '700' },
    friendBtnTextDone: { color: colors.textMuted },
    blockedNotice: { color: colors.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 18 },
    incomingNotice: { color: colors.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 18 },
    respondRow: { flexDirection: 'row', width: '100%', gap: 10 },
    respondHalf: { width: 'auto', flex: 1 },
    declineBtn: {
      flexDirection: 'row',
      backgroundColor: 'transparent',
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      paddingVertical: 14,
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 48,
    },
    declineBtnText: { color: colors.textMuted, fontSize: 15, fontWeight: '700' },
    blockBtn: {
      flexDirection: 'row',
      width: '100%',
      backgroundColor: 'transparent',
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.accent,
      paddingVertical: 14,
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 48,
    },
    blockBtnText: { color: colors.accent, fontSize: 15, fontWeight: '700' },

    statsCard: {
      flexDirection: 'row',
      backgroundColor: colors.card,
      marginHorizontal: 16,
      marginTop: 12,
      borderRadius: 16,
      paddingVertical: 20,
      borderWidth: 1,
      borderColor: colors.border,
    },
    statItem: { flex: 1, alignItems: 'center' },
    statDivider: { width: 1, backgroundColor: colors.border },
    statValue: { color: colors.text, fontSize: 28, fontWeight: '800' },
    statLabel: { color: colors.textMuted, fontSize: 12, marginTop: 2 },

    section: { marginHorizontal: 16, marginTop: 20 },
    sectionTitle: { color: colors.textSubtle, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, marginBottom: 10 },

    vehicleCard: {
      backgroundColor: colors.card,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 16,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
    },
    vehicleIconBg: {
      width: 48,
      height: 48,
      borderRadius: 12,
      backgroundColor: colors.cardElevated,
      alignItems: 'center',
      justifyContent: 'center',
    },
    vehicleInfo: { flex: 1 },
    vehicleLabel: { color: colors.text, fontSize: 16, fontWeight: '700' },
    vehicleColor: { color: colors.textMuted, fontSize: 13, marginTop: 2 },

    modsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
    modChip: {
      backgroundColor: colors.cardElevated,
      borderRadius: 100,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 12,
      paddingVertical: 5,
    },
    modText: { color: colors.text, fontSize: 13 },

  });
}
