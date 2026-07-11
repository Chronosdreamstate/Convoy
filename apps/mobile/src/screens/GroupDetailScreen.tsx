import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { apiClient } from '../services/apiClient';
import { SkeletonBox, SkeletonRow } from '../components/SkeletonLoader';
import { useTheme, withAlpha, ThemeColors } from '../theme';

// Text/icons that always sit on the crimson accent fill — stays light in both themes.
const ON_ACCENT = '#FFFFFF';

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
  vehicleFocus?: string | null;
  members: Array<{ userId: string; displayName: string; isAdmin: boolean; vehicleType?: string }>;
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

type VehicleIconName = keyof typeof MaterialCommunityIcons.glyphMap;

function getVehicleIconName(vehicleType: string | undefined): VehicleIconName {
  const map: Record<string, VehicleIconName> = {
    car: 'car', sports_car: 'car-sports', suv: 'car-estate',
    truck: 'car-pickup', motorcycle: 'motorbike', van: 'van-passenger', track_car: 'car-sports',
  };
  return map[vehicleType?.toLowerCase() ?? ''] ?? 'car';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

// Dimensions-only (no color) so this module-level component doesn't need the themed styles sheet
const skeletonContainerStyle = { paddingHorizontal: 20, paddingTop: 24 } as const;

function DetailSkeleton() {
  return (
    <View style={skeletonContainerStyle}>
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
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Real measured height of the absolutely-positioned bottom action bar, so the
  // scroll content can reserve exactly enough space to clear it (see footer
  // below). Starts at a sane estimate so there's no flash of under-padding
  // before the first onLayout fires.
  const [footerHeight, setFooterHeight] = useState(100);
  // Total upcoming events, from GET /groups/:id/events (`total` is optional —
  // being added server-side). Purely decorative on the "See all events" row;
  // null (endpoint failed / field absent) just hides the count.
  const [eventsTotal, setEventsTotal] = useState<number | null>(null);

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

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchGroup();
    setRefreshing(false);
  }, [fetchGroup]);

  useEffect(() => { void fetchGroup(); }, [fetchGroup]);

  // Best-effort fetch of the upcoming-events total for the "See all events"
  // affordance. Non-blocking and silent on failure — the row works without it.
  const hasUpcomingEvent = !!group?.upcomingEvent;
  useEffect(() => {
    if (!id || !hasUpcomingEvent) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiClient.get<{ total?: number }>(`/api/v1/groups/${id}/events`);
        const total = typeof res.data?.total === 'number' ? res.data.total : null;
        if (!cancelled) setEventsTotal(total);
      } catch {
        // decorative only — leave the label as plain "See all events"
      }
    })();
    return () => { cancelled = true; };
  }, [id, hasUpcomingEvent]);

  const handleShare = useCallback(async () => {
    if (!group || sharing) return;
    setSharing(true);
    try {
      const res = await apiClient.get<{ link: string; code: string }>(`/api/v1/groups/${group.id}/invite-link`);
      const { link, code } = res.data;
      await Share.share({
        message: [
          `Join "${group.name}" on CORTEGE! 🏎️`,
          `${group.memberCount} riders and counting.`,
          ``,
          `Tap to join: ${link}`,
          code ? `Or use code: ${code}` : '',
        ].filter(Boolean).join('\n'),
        url: link,
        title: `Join ${group.name} on CORTEGE`,
      });
    } catch {
      // fallback share without invite link; swallow a second failure too —
      // an unhandled rejection here would escape the outer catch
      await Share.share({
        message: `Check out "${group.name}" on CORTEGE — the car enthusiast convoy app! convoy.app`,
        title: `Join ${group.name} on CORTEGE`,
      }).catch(() => {});
    } finally {
      setSharing(false);
    }
  }, [group, sharing]);

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
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back">
          <Text style={styles.backText}>
            <Ionicons name="chevron-back" size={16} color={colors.accent} /> Back
          </Text>
        </TouchableOpacity>
        <DetailSkeleton />
      </SafeAreaView>
    );
  }

  if (error || !group) {
    return (
      <SafeAreaView style={styles.container}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back">
          <Text style={styles.backText}>
            <Ionicons name="chevron-back" size={16} color={colors.accent} /> Back
          </Text>
        </TouchableOpacity>
        <View style={styles.errorContainer}>
          <Ionicons name="cloud-offline-outline" size={52} color={colors.textMuted} style={styles.errorIcon} />
          <Text style={styles.errorTitle}>Couldn&apos;t load group</Text>
          <Text style={styles.errorText}>{error ?? 'This group may have been removed or is no longer available.'}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={fetchGroup} accessibilityRole="button" accessibilityLabel="Retry loading group">
            <Text style={styles.retryText}>
              <Ionicons name="refresh" size={15} color={ON_ACCENT} /> Try Again
            </Text>
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
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel="Go back">
          <Text style={styles.backText}>
            <Ionicons name="chevron-back" size={16} color={colors.accent} /> Back
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleShare}
          disabled={sharing}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Share group"
          accessibilityState={{ busy: sharing }}
        >
          {sharing ? (
            <ActivityIndicator size="small" color={colors.text} />
          ) : (
            <Ionicons name="share-social-outline" size={22} color={colors.text} />
          )}
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: footerHeight + 24 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} />
        }
      >
        {/* Group name + admin */}
        <Text style={styles.groupName}>{group.name}</Text>
        <Text style={styles.adminText}>
          <MaterialCommunityIcons name="crown" size={13} color={colors.textMuted} /> Led by {group.adminDisplayName}
        </Text>

        {/* Access type badge */}
        <View style={styles.badgeRow}>
          <View style={[styles.badge, group.accessType === 'open' ? styles.badgeOpen : styles.badgeLocked]}>
            <Text style={styles.badgeText}>
              <Ionicons name={group.accessType === 'open' ? 'globe-outline' : 'lock-closed-outline'} size={12} color={colors.text} />
              {group.accessType === 'open' ? ' Open' : ' Invite Only'}
            </Text>
          </View>
          {group.status === 'active' && (
            <View style={styles.badgeLive}>
              <Text style={styles.badgeText}>
                <Text style={styles.badgeLiveDot}>●</Text> Live
              </Text>
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
                <View key={m.userId} style={{ alignItems: 'center', marginLeft: i > 0 ? -8 : 0, zIndex: 10 - i }}>
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>{initials(m.displayName)}</Text>
                  </View>
                  <MaterialCommunityIcons name={getVehicleIconName(m.vehicleType)} size={10} color={colors.textMuted} style={{ marginTop: 2 }} />
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

        {/* Upcoming event — tappable through to the event detail screen so a
            rider can RSVP from here instead of dead-ending on a static card. */}
        {group.upcomingEvent && (
          <>
            <TouchableOpacity
              style={styles.eventCard}
              onPress={() =>
                router.push({
                  pathname: '/event/[id]',
                  params: { id: group.upcomingEvent!.id, groupId: group.id },
                } as never)
              }
              accessibilityRole="button"
              accessibilityLabel={`Next drive: ${group.upcomingEvent.title}, ${formatDate(group.upcomingEvent.scheduledFor)}. View details and RSVP`}
            >
              <View style={styles.eventCardBody}>
                <Text style={styles.eventTitle}>
                  <Ionicons name="calendar-outline" size={11} color={colors.warning} /> Next drive
                </Text>
                <Text style={styles.eventName}>{group.upcomingEvent.title}</Text>
                <Text style={styles.eventDate}>{formatDate(group.upcomingEvent.scheduledFor)}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>

            {/* Full events list — the card above only surfaces the next drive */}
            <TouchableOpacity
              style={styles.seeAllEventsBtn}
              onPress={() =>
                router.push({
                  pathname: '/group/[id]/events',
                  params: { id: group.id, groupName: group.name },
                } as never)
              }
              accessibilityRole="button"
              accessibilityLabel={
                eventsTotal !== null && eventsTotal > 0
                  ? `See all ${eventsTotal} upcoming events for this group`
                  : 'See all upcoming events for this group'
              }
            >
              <Ionicons name="calendar-outline" size={15} color={colors.textMuted} />
              <Text style={styles.seeAllEventsText}>
                {eventsTotal !== null && eventsTotal > 0 ? `See all events (${eventsTotal})` : 'See all events'}
              </Text>
              <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
            </TouchableOpacity>
          </>
        )}
      </ScrollView>

      {/* Action buttons */}
      <View
        style={styles.footer}
        onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}
      >
        <View style={styles.footerRow}>
          {group.isMember ? (
            <TouchableOpacity
              style={[styles.viewBtn, { flex: 1 }]}
              onPress={() => router.replace('/(tabs)/convoy')}
              accessibilityRole="button"
              accessibilityLabel="View convoy"
            >
              <Text style={styles.joinText}>
                <MaterialCommunityIcons name="car" size={16} color={colors.text} /> View Convoy
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.joinBtn, { flex: 1 }, joining && styles.joinBtnDisabled]}
              onPress={handleJoin}
              disabled={joining}
              accessibilityRole="button"
              accessibilityLabel="Join Convoy"
              accessibilityState={{ disabled: joining, busy: joining }}
            >
              {joining ? (
                <ActivityIndicator color={ON_ACCENT} />
              ) : (
                <Text style={styles.joinBtnText}>Join Convoy</Text>
              )}
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.leaderboardBtn}
            onPress={() =>
              router.push({
                pathname: '/convoy-history/[groupId]',
                params: { groupId: group.id, groupName: group.name },
              } as never)
            }
            accessibilityRole="button"
            accessibilityLabel="View convoy history"
          >
            <Ionicons name="time-outline" size={22} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.leaderboardBtn}
            onPress={() =>
              router.push({
                pathname: '/leaderboard',
                params: { groupId: group.id, groupName: group.name },
              } as never)
            }
            accessibilityRole="button"
            accessibilityLabel="View leaderboard"
          >
            <Ionicons name="trophy-outline" size={22} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.leaderboardBtn}
            onPress={() => router.push(`/group-stats/${group.id}` as never)}
            accessibilityRole="button"
            accessibilityLabel="View group stats"
          >
            <Ionicons name="stats-chart-outline" size={22} color={colors.text} />
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  shareHeaderBtn: { fontSize: 22 },
  backBtn: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  backText: { color: colors.accent, fontSize: 17, fontWeight: '600' },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 16 },
  skeletonContainer: { paddingHorizontal: 20, paddingTop: 24 },
  errorContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  errorIcon: { marginBottom: 16 },
  errorTitle: { color: colors.text, fontSize: 18, fontWeight: '700', textAlign: 'center', marginBottom: 8 },
  errorText: { color: colors.textMuted, fontSize: 15, textAlign: 'center', lineHeight: 21, marginBottom: 20 },
  retryBtn: { backgroundColor: colors.accent, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, minHeight: 44, justifyContent: 'center' },
  retryText: { color: ON_ACCENT, fontSize: 15, fontWeight: '700' },

  groupName: { color: colors.text, fontSize: 28, fontWeight: '700', marginBottom: 4 },
  adminText: { color: colors.textMuted, fontSize: 14, marginBottom: 16 },

  badgeRow: { flexDirection: 'row', gap: 8, marginBottom: 20 },
  badge: { borderRadius: 100, paddingHorizontal: 12, paddingVertical: 4 },
  badgeOpen: { backgroundColor: withAlpha(colors.accent, 0.15), borderWidth: 1, borderColor: colors.accent },
  badgeLocked: { backgroundColor: withAlpha(colors.textMuted, 0.12), borderWidth: 1, borderColor: colors.border },
  badgeLive: { backgroundColor: withAlpha(colors.success, 0.15), borderWidth: 1, borderColor: colors.success, borderRadius: 100, paddingHorizontal: 12, paddingVertical: 4 },
  badgeText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  badgeLiveDot: { color: colors.success },

  statsRow: { flexDirection: 'row', gap: 8, marginBottom: 24 },
  statCard: { flex: 1, backgroundColor: colors.card, borderRadius: 12, padding: 12, alignItems: 'center' },
  statValue: { color: colors.text, fontSize: 18, fontWeight: '700' },
  statLabel: { color: colors.textMuted, fontSize: 11, marginTop: 2 },

  section: { marginBottom: 20 },
  sectionLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '600', letterSpacing: 1, marginBottom: 10 },

  avatarRow: { flexDirection: 'row', alignItems: 'center' },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.bg },
  avatarText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  avatarExtra: { backgroundColor: colors.border },
  avatarExtraText: { color: colors.textMuted, fontSize: 11, fontWeight: '600' },

  eventCard: {
    backgroundColor: colors.card, borderRadius: 12, padding: 16,
    borderLeftWidth: 4, borderLeftColor: colors.warning, marginBottom: 16,
    flexDirection: 'row', alignItems: 'center', minHeight: 44,
  },
  eventCardBody: { flex: 1 },
  eventTitle: { color: colors.warning, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginBottom: 4 },
  eventName: { color: colors.text, fontSize: 16, fontWeight: '600', marginBottom: 4 },
  eventDate: { color: colors.textMuted, fontSize: 13 },
  seeAllEventsBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border,
    minHeight: 44, paddingHorizontal: 16, marginBottom: 16,
  },
  seeAllEventsText: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },

  footer: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 20, backgroundColor: colors.bg, borderTopWidth: 1, borderTopColor: colors.card },
  footerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  joinBtn: { backgroundColor: colors.accent, borderRadius: 16, paddingVertical: 18, alignItems: 'center' },
  joinBtnDisabled: { opacity: 0.5 },
  viewBtn: { backgroundColor: colors.card, borderRadius: 16, paddingVertical: 18, alignItems: 'center', borderWidth: 1, borderColor: colors.accent },
  // "View Convoy" sits on a card fill (theme text color); "Join Convoy" sits
  // on the accent fill (always-light text).
  joinText: { color: colors.text, fontSize: 17, fontWeight: '700' },
  joinBtnText: { color: ON_ACCENT, fontSize: 17, fontWeight: '700' },
  leaderboardBtn: { width: 56, height: 56, borderRadius: 16, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  leaderboardIcon: { fontSize: 24 },
  });
}
