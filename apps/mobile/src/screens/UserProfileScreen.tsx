import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { apiClient } from '../services/apiClient';

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

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [friendStatus, setFriendStatus] = useState<string | null>(null);
  const [friendLoading, setFriendLoading] = useState(false);

  const fadeAnim = React.useRef(new Animated.Value(0)).current;

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.get<UserProfile>(`/api/v1/users/${userId}`);
      setProfile(res.data);
      setFriendStatus(res.data.friendStatus);
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
      await apiClient.post('/api/v1/friends/requests', { addresseeId: profile.id });
      setFriendStatus('pending');
    } catch {
      // silently ignore
    } finally {
      setFriendLoading(false);
    }
  };

  const handleShare = async () => {
    if (!profile) return;
    await Share.share({ message: `Check out ${profile.displayName} on CONVOY!` }).catch(() => {});
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.centered}>
        <ActivityIndicator size="large" color="#DC143C" />
      </SafeAreaView>
    );
  }

  if (error || !profile) {
    return (
      <SafeAreaView style={styles.centered}>
        <Text style={styles.errorText}>{error ?? 'User not found.'}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={() => void load()}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const friendBtnLabel = friendStatus === 'pending'
    ? '✓ Request Sent'
    : friendStatus === 'accepted'
    ? '✓ Friends'
    : '🤝 Add Friend';
  const friendBtnDisabled = friendStatus === 'pending' || friendStatus === 'accepted' || friendLoading;

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      {/* Header bar */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back">
          <Text style={styles.backIcon}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Profile</Text>
        <TouchableOpacity style={styles.shareBtn} onPress={() => void handleShare()} accessibilityRole="button" accessibilityLabel="Share profile">
          <Text style={styles.shareIcon}>↑</Text>
        </TouchableOpacity>
      </View>

      <Animated.ScrollView style={{ opacity: fadeAnim }} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Hero card */}
        <View style={styles.heroCard}>
          <View style={[styles.avatar, { backgroundColor: '#DC143C' }]}>
            <Text style={styles.avatarText}>{initials(profile.displayName)}</Text>
          </View>

          <Text style={styles.name}>{profile.displayName}</Text>

          {profile.callsign && (
            <View style={styles.callsignBadge}>
              <Text style={styles.callsignText}>📻 {profile.callsign}</Text>
            </View>
          )}

          {profile.mutualFriends > 0 && (
            <Text style={styles.mutualText}>
              {profile.mutualFriends} mutual {profile.mutualFriends === 1 ? 'friend' : 'friends'}
            </Text>
          )}

          {profile.bio ? <Text style={styles.bio}>{profile.bio}</Text> : null}

          <Text style={styles.memberSince}>Member since {memberYear(profile.memberSince)}</Text>

          {/* Action buttons */}
          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.friendBtn, friendBtnDisabled && styles.friendBtnDone]}
              onPress={() => void handleAddFriend()}
              disabled={friendBtnDisabled}
              accessibilityRole="button"
            >
              <Text style={styles.friendBtnText}>{friendLoading ? 'Sending...' : friendBtnLabel}</Text>
            </TouchableOpacity>
          </View>
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
              <Text style={styles.vehicleIcon}>🚗</Text>
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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A0A0A' },
  centered: { flex: 1, backgroundColor: '#0A0A0A', alignItems: 'center', justifyContent: 'center' },
  scroll: { paddingBottom: 40 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A2A',
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backIcon: { color: '#FFFFFF', fontSize: 28, fontWeight: '300', lineHeight: 32 },
  headerTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', letterSpacing: 0.5 },
  shareBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  shareIcon: { color: '#DC143C', fontSize: 22, fontWeight: '700' },

  heroCard: {
    backgroundColor: '#1C1C1C',
    marginHorizontal: 16,
    marginTop: 20,
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2A2A2A',
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
  name: { color: '#FFFFFF', fontSize: 22, fontWeight: '800', marginBottom: 8, textAlign: 'center' },
  callsignBadge: {
    backgroundColor: '#0A0A0A',
    borderRadius: 100,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 14,
    paddingVertical: 5,
    marginBottom: 8,
  },
  callsignText: { color: '#888888', fontSize: 13, fontWeight: '600' },
  mutualText: { color: '#888888', fontSize: 13, marginBottom: 8 },
  bio: { color: '#CCCCCC', fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 8 },
  memberSince: { color: '#555555', fontSize: 12, marginBottom: 16 },

  actionRow: { width: '100%', gap: 10 },
  friendBtn: {
    width: '100%',
    backgroundColor: '#DC143C',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  friendBtnDone: { backgroundColor: '#1C1C1C', borderWidth: 1, borderColor: '#2A2A2A' },
  friendBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },

  statsCard: {
    flexDirection: 'row',
    backgroundColor: '#1C1C1C',
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 16,
    paddingVertical: 20,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  statItem: { flex: 1, alignItems: 'center' },
  statDivider: { width: 1, backgroundColor: '#2A2A2A' },
  statValue: { color: '#FFFFFF', fontSize: 28, fontWeight: '800' },
  statLabel: { color: '#888888', fontSize: 12, marginTop: 2 },

  section: { marginHorizontal: 16, marginTop: 20 },
  sectionTitle: { color: '#555555', fontSize: 11, fontWeight: '700', letterSpacing: 1.5, marginBottom: 10 },

  vehicleCard: {
    backgroundColor: '#1C1C1C',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  vehicleIconBg: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: '#242424',
    alignItems: 'center',
    justifyContent: 'center',
  },
  vehicleIcon: { fontSize: 24 },
  vehicleInfo: { flex: 1 },
  vehicleLabel: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  vehicleColor: { color: '#888888', fontSize: 13, marginTop: 2 },

  modsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  modChip: {
    backgroundColor: '#242424',
    borderRadius: 100,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  modText: { color: '#CCCCCC', fontSize: 13 },

  errorText: { color: '#888888', fontSize: 15, marginBottom: 16 },
  retryBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 12,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  retryText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },
});
