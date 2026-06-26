import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { apiClient } from '../services/apiClient';
import { SkeletonBox, SkeletonRow } from '../components/SkeletonLoader';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GroupEvent {
  id: string;
  title: string;
  scheduledFor: string;
}

interface GroupDetail {
  id: string;
  name: string;
  adminDisplayName: string;
  memberCount: number;
  gapThresholdM: number;
  accessType: 'open' | 'invite_only';
  status: string;
  createdAt: string;
  members: Array<{ userId: string; displayName: string; isAdmin: boolean }>;
  upcomingEvent?: GroupEvent;
  isMember?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function initials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function DetailSkeleton() {
  return (
    <View style={styles.skeletonContainer}>
      <View style={{ marginBottom: 8 }}>
        <SkeletonBox height={28} width="60%" />
      </View>
      <View style={{ marginBottom: 24 }}>
        <SkeletonBox height={16} width="40%" />
      </View>
      <SkeletonRow />
      <SkeletonRow />
      <SkeletonRow />
    </View>
  );
}

// ---------------------------------------------------------------------------
// GroupDetailScreen
// ---------------------------------------------------------------------------

export default function GroupDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  const fetchGroup = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.get<GroupDetail>(`/api/v1/groups/${id}`);
      setGroup(res.data);
    } catch {
      setError('Could not load group. Tap to retry.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void fetchGroup(); }, [fetchGroup]);

  const handleJoin = async () => {
    if (!id) return;
    setJoining(true);
    try {
      await apiClient.post(`/api/v1/groups/${id}/members`, {});
      router.replace('/(tabs)/convoy');
    } catch (e: unknown) {
      const status = (e as { status?: number }).status;
      if (status === 409) {
        router.replace('/(tabs)/convoy');
      } else {
        Alert.alert('Could not join', 'Try again in a moment.');
      }
    } finally {
      setJoining(false);
    }
  };

  // -------------------------------------------------------------------------
  // Render states
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
        <DetailSkeleton />
      </SafeAreaView>
    );
  }

  if (error || !group) {
    return (
      <SafeAreaView style={styles.container}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error ?? 'Group not found.'}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={fetchGroup}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const visibleMembers = group.members?.slice(0, 5) ?? [];
  const extraCount = (group.memberCount ?? 0) - visibleMembers.length;

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Group name + admin */}
        <Text style={styles.groupName}>{group.name}</Text>
        <Text style={styles.adminText}>👑 Led by {group.adminDisplayName}</Text>

        {/* Access type badge */}
        <View style={styles.badgeRow}>
          <View style={[styles.badge, group.accessType === 'open' ? styles.badgeOpen : styles.badgeLocked]}>
            <Text style={styles.badgeText}>
              {group.accessType === 'open' ? '🌐 Open' : '🔒 Invite Only'}
            </Text>
          </View>
          {group.status === 'active' && (
            <View style={styles.badgeLive}>
              <Text style={styles.badgeText}>● Live</Text>
            </View>
          )}
        </View>

        {/* Stats row */}
        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{group.memberCount}</Text>
            <Text style={styles.statLabel}>Riders</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{group.gapThresholdM < 1000 ? `${group.gapThresholdM}m` : `${(group.gapThresholdM / 1000).toFixed(1)}km`}</Text>
            <Text style={styles.statLabel}>Gap limit</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{new Date(group.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</Text>
            <Text style={styles.statLabel}>Created</Text>
          </View>
        </View>

        {/* Member avatars */}
        {visibleMembers.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>MEMBERS</Text>
            <View style={styles.avatarRow}>
              {visibleMembers.map((m, i) => (
                <View key={m.userId} style={[styles.avatar, { marginLeft: i > 0 ? -8 : 0, zIndex: 10 - i }]}>
                  <Text style={styles.avatarText}>{initials(m.displayName)}</Text>
                </View>
              ))}
              {extraCount > 0 && (
                <View style={[styles.avatar, styles.avatarExtra, { marginLeft: -8 }]}>
                  <Text style={styles.avatarExtraText}>+{extraCount}</Text>
                </View>
              )}
            </View>
          </View>
        )}

        {/* Upcoming event */}
        {group.upcomingEvent && (
          <View style={styles.eventCard}>
            <Text style={styles.eventTitle}>📅 Next drive</Text>
            <Text style={styles.eventName}>{group.upcomingEvent.title}</Text>
            <Text style={styles.eventDate}>{formatDate(group.upcomingEvent.scheduledFor)}</Text>
          </View>
        )}

        {/* Spacer for bottom button */}
        <View style={{ height: 100 }} />
      </ScrollView>

      {/* Action buttons */}
      <View style={styles.footer}>
        <View style={styles.footerRow}>
          {group.isMember ? (
            <TouchableOpacity
              style={[styles.viewBtn, { flex: 1 }]}
              onPress={() => router.replace('/(tabs)/convoy')}
            >
              <Text style={styles.joinText}>🚗 View Convoy</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.joinBtn, { flex: 1 }, joining && styles.joinBtnDisabled]}
              onPress={handleJoin}
              disabled={joining}
            >
              {joining ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.joinText}>Join Convoy</Text>
              )}
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.leaderboardBtn}
            onPress={() =>
              router.push({
                pathname: '/leaderboard',
                params: { groupId: group.id, groupName: group.name },
              } as never)
            }
            accessibilityLabel="View leaderboard"
          >
            <Text style={styles.leaderboardIcon}>🏆</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  backBtn: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  backText: { color: '#DC143C', fontSize: 17, fontWeight: '600' },
  content: { paddingHorizontal: 20, paddingTop: 16 },
  skeletonContainer: { paddingHorizontal: 20, paddingTop: 24 },
  errorContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  errorText: { color: '#888888', fontSize: 15, textAlign: 'center', marginBottom: 20 },
  retryBtn: { backgroundColor: '#DC143C', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 },
  retryText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },

  groupName: { color: '#FFFFFF', fontSize: 28, fontWeight: '700', marginBottom: 4 },
  adminText: { color: '#888888', fontSize: 14, marginBottom: 16 },

  badgeRow: { flexDirection: 'row', gap: 8, marginBottom: 20 },
  badge: { borderRadius: 100, paddingHorizontal: 12, paddingVertical: 4 },
  badgeOpen: { backgroundColor: 'rgba(220,20,60,0.15)', borderWidth: 1, borderColor: '#DC143C' },
  badgeLocked: { backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: '#2A2A2A' },
  badgeLive: { backgroundColor: 'rgba(34,197,94,0.15)', borderWidth: 1, borderColor: '#22C55E', borderRadius: 100, paddingHorizontal: 12, paddingVertical: 4 },
  badgeText: { color: '#FFFFFF', fontSize: 12, fontWeight: '600' },

  statsRow: { flexDirection: 'row', gap: 8, marginBottom: 24 },
  statCard: { flex: 1, backgroundColor: '#1C1C1C', borderRadius: 12, padding: 12, alignItems: 'center' },
  statValue: { color: '#FFFFFF', fontSize: 18, fontWeight: '700' },
  statLabel: { color: '#888888', fontSize: 11, marginTop: 2 },

  section: { marginBottom: 20 },
  sectionLabel: { color: '#888888', fontSize: 11, fontWeight: '600', letterSpacing: 1, marginBottom: 10 },

  avatarRow: { flexDirection: 'row', alignItems: 'center' },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#1C1C1C', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#0A0A0A' },
  avatarText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  avatarExtra: { backgroundColor: '#2A2A2A' },
  avatarExtraText: { color: '#888888', fontSize: 11, fontWeight: '600' },

  eventCard: { backgroundColor: '#1C1C1C', borderRadius: 12, padding: 16, borderLeftWidth: 4, borderLeftColor: '#F59E0B', marginBottom: 16 },
  eventTitle: { color: '#F59E0B', fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginBottom: 4 },
  eventName: { color: '#FFFFFF', fontSize: 16, fontWeight: '600', marginBottom: 4 },
  eventDate: { color: '#888888', fontSize: 13 },

  footer: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 20, backgroundColor: '#0A0A0A', borderTopWidth: 1, borderTopColor: '#1C1C1C' },
  footerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  joinBtn: { backgroundColor: '#DC143C', borderRadius: 16, paddingVertical: 18, alignItems: 'center' },
  joinBtnDisabled: { opacity: 0.5 },
  viewBtn: { backgroundColor: '#1C1C1C', borderRadius: 16, paddingVertical: 18, alignItems: 'center', borderWidth: 1, borderColor: '#DC143C' },
  joinText: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
  leaderboardBtn: { width: 56, height: 56, borderRadius: 16, backgroundColor: '#1C1C1C', borderWidth: 1, borderColor: '#2A2A2A', alignItems: 'center', justifyContent: 'center' },
  leaderboardIcon: { fontSize: 24 },
});
