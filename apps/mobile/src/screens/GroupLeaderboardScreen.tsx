/**
 * GroupLeaderboardScreen — ranked member stats within a group.
 *
 * Three metric tabs: Distance | Convoys | Time
 * API: GET /api/v1/groups/{groupId}/leaderboard?metric=distance&limit=20
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Image,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SkeletonRow } from '../components/SkeletonLoader';
import { NetworkError } from '../components/NetworkError';
import { apiClient } from '../services/apiClient';
import { useAuthStore } from '../stores/authStore';
import { ThemeColors, useTheme, withAlpha } from '../theme';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Metric = 'distance' | 'convoys' | 'time';

interface LeaderboardMember {
  rank: number;
  userId: string;
  displayName: string;
  callsign: string | null;
  avatarUrl?: string | null;
  totalDistanceKm: number;
  driveCount: number;
  totalDurationMin: number;
  value: number;
}

interface LeaderboardResponse {
  leaderboard: LeaderboardMember[];
  /**
   * The current user's own rank/value when they fall outside the visible
   * rows. Being added server-side — optional until that change lands, and
   * null when the user has no ranked data for the metric.
   */
  me?: { rank: number; value: number } | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABS: { label: string; metric: Metric }[] = [
  { label: 'Distance', metric: 'distance' },
  { label: 'Convoys', metric: 'convoys' },
  { label: 'Time', metric: 'time' },
];

// Medal emoji for top-3 ranks are intentional, playful gamification content
// (same spirit as achievement badges) — not UI chrome, left as emoji.
const MEDALS: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

const SKELETON_COUNT = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatValue(value: number, metric: Metric): string {
  if (metric === 'distance') {
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k km`;
    return `${value} km`;
  }
  if (metric === 'convoys') {
    return `${value} ${value === 1 ? 'convoy' : 'convoys'}`;
  }
  // time: value expressed in minutes
  const hours = Math.floor(value / 60);
  const mins = value % 60;
  if (hours === 0) return `${mins}m`;
  return `${hours}h ${mins}m`;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Avatar({ uri, name, styles }: { uri?: string; name: string; styles: Styles }) {
  const [failed, setFailed] = useState(false);

  if (uri && !failed) {
    return (
      <Image
        source={{ uri }}
        style={styles.avatar}
        onError={() => setFailed(true)}
        accessibilityLabel={`${name} avatar`}
      />
    );
  }

  return (
    <View style={[styles.avatar, styles.avatarFallback]}>
      <Text style={styles.avatarInitials} numberOfLines={1}>
        {getInitials(name)}
      </Text>
    </View>
  );
}

function RankBadge({ rank, styles }: { rank: number; styles: Styles }) {
  const medal = MEDALS[rank];

  if (medal) {
    return (
      <View style={styles.rankBadge}>
        <Text style={styles.rankMedal}>{medal}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.rankBadge, styles.rankCircle]}>
      <Text style={styles.rankNumber}>{rank}</Text>
    </View>
  );
}

function MemberRow({
  member,
  rank,
  metric,
  isYou,
  styles,
}: {
  member: LeaderboardMember;
  rank: number;
  metric: Metric;
  isYou: boolean;
  styles: Styles;
}) {
  const isFirst = rank === 1;

  return (
    <View
      style={[styles.row, isFirst && styles.rowFirst, isYou && styles.rowYou]}
      accessibilityLabel={`Rank ${rank}: ${member.displayName}${isYou ? ', you' : ''}, ${formatValue(member.value, metric)}`}
    >
      <RankBadge rank={rank} styles={styles} />
      <Avatar uri={member.avatarUrl ?? undefined} name={member.displayName} styles={styles} />
      <View style={styles.memberInfo}>
        <View style={styles.nameRow}>
          <Text style={styles.displayName} numberOfLines={1}>
            {member.displayName}
          </Text>
          {isYou && (
            <View style={styles.youBadge}>
              <Text style={styles.youBadgeText}>YOU</Text>
            </View>
          )}
        </View>
        {member.callsign ? (
          <Text style={styles.callsign} numberOfLines={1}>
            {member.callsign}
          </Text>
        ) : null}
      </View>
      <Text style={styles.statValue} numberOfLines={1}>
        {formatValue(member.value, metric)}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Header — extracted for reuse across loading/data states
// ---------------------------------------------------------------------------

function Header({ onBack, styles, colors, hitSlop }: { onBack: () => void; styles: Styles; colors: ThemeColors; hitSlop: { top: number; bottom: number; left: number; right: number } }) {
  return (
    <View style={styles.header}>
      <TouchableOpacity
        onPress={onBack}
        hitSlop={hitSlop}
        style={styles.backButton}
        accessibilityRole="button"
        accessibilityLabel="Go back"
      >
        <Ionicons name="chevron-back" size={22} color={colors.accent} />
        <Text style={styles.backButtonText}>Back</Text>
      </TouchableOpacity>
      <Text style={styles.headerTitle}>Leaderboard</Text>
      {/* Phantom view to balance flex layout */}
      <View style={styles.headerSpacer} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function MetricTabs({
  active,
  onChange,
  styles,
}: {
  active: Metric;
  onChange: (m: Metric) => void;
  styles: Styles;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.tabsScroll}
      contentContainerStyle={styles.tabsContent}
    >
      {TABS.map(({ label, metric }) => {
        const isActive = metric === active;
        return (
          <TouchableOpacity
            key={metric}
            style={[styles.tab, isActive && styles.tabActive]}
            onPress={() => onChange(metric)}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
          >
            <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
              {label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function GroupLeaderboardScreen() {
  const { colors, spacing, radius, typography, hitSlop } = useTheme();
  const styles = useMemo(() => createStyles(colors, spacing, radius, typography), [colors, spacing, radius, typography]);

  const router = useRouter();
  const params = useLocalSearchParams<{ groupId: string }>();
  const groupId = Array.isArray(params.groupId) ? params.groupId[0] : (params.groupId ?? '');
  const currentUserId = useAuthStore((s) => s.user?.id);

  const [activeMetric, setActiveMetric] = useState<Metric>('distance');
  const [members, setMembers] = useState<LeaderboardMember[]>([]);
  const [myRank, setMyRank] = useState<{ rank: number; value: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  const fetchLeaderboard = useCallback(
    async (metric: Metric) => {
      try {
        const res = await apiClient.get<LeaderboardResponse>(
          `/api/v1/groups/${groupId}/leaderboard`,
          { params: { metric, limit: 20 } },
        );
        setMembers(res.data.leaderboard ?? []);
        // Defensive: `me` may be absent until the API change lands, or null
        // when the user has no ranked data — hide the pinned row in both cases.
        const me = res.data.me;
        setMyRank(
          me && typeof me.rank === 'number' && typeof me.value === 'number' ? me : null,
        );
        setError(false);
      } catch {
        // A failed fetch must not render identically to a genuine "nobody's
        // driven yet" empty state — track it separately so the user sees a
        // retry affordance instead of a misleading "No data yet".
        setError(true);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [groupId],
  );

  // Reload when metric tab switches
  useEffect(() => {
    setLoading(true);
    setMembers([]);
    setMyRank(null);
    void fetchLeaderboard(activeMetric);
  }, [activeMetric, fetchLeaderboard]);

  const handleTabChange = useCallback((metric: Metric) => {
    setActiveMetric(metric);
  }, []);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void fetchLeaderboard(activeMetric);
  }, [fetchLeaderboard, activeMetric]);

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const renderMemberItem = useCallback(
    ({ item, index }: { item: LeaderboardMember; index: number }) => (
      <MemberRow
        member={item}
        rank={index + 1}
        metric={activeMetric}
        isYou={item.userId === currentUserId}
        styles={styles}
      />
    ),
    [activeMetric, currentUserId, styles],
  );

  // ------------------------------------------------------------------
  // Loading skeleton
  // ------------------------------------------------------------------
  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <Header onBack={handleBack} styles={styles} colors={colors} hitSlop={hitSlop} />
        <MetricTabs active={activeMetric} onChange={handleTabChange} styles={styles} />
        <View style={styles.skeletonList}>
          {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
            <View key={i} style={styles.skeletonWrapper}>
              <SkeletonRow />
            </View>
          ))}
        </View>
      </SafeAreaView>
    );
  }

  // ------------------------------------------------------------------
  // Data / empty state
  // ------------------------------------------------------------------

  // Pinned "your rank" row — only when the signed-in user exists in the
  // response's `me` field but is NOT one of the visible rows (outside top-N).
  const showMyRank =
    myRank !== null &&
    members.length > 0 &&
    !members.some((m) => m.userId === currentUserId);

  return (
    <SafeAreaView style={styles.container}>
      <Header onBack={handleBack} styles={styles} colors={colors} hitSlop={hitSlop} />
      <MetricTabs active={activeMetric} onChange={handleTabChange} styles={styles} />

      {error && members.length === 0 ? (
        <NetworkError
          onRetry={() => { setLoading(true); void fetchLeaderboard(activeMetric); }}
          message="Could not load the leaderboard."
        />
      ) : (
        <FlatList
          data={members}
          keyExtractor={(item) => item.userId}
          contentContainerStyle={
            members.length === 0 ? styles.listEmpty : styles.list
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={colors.accent}
              colors={[colors.accent]}
            />
          }
          ListHeaderComponent={
            error ? <Text style={styles.errorBanner}>Couldn't refresh — showing last loaded data</Text> : null
          }
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyEmoji}>🏆</Text>
              <Text style={styles.emptyTitle}>No data yet</Text>
              <Text style={styles.emptySubtitle}>
                Complete a convoy to appear on the leaderboard
              </Text>
            </View>
          }
          renderItem={renderMemberItem}
          showsVerticalScrollIndicator={false}
        />
      )}

      {/* Pinned "your rank" footer — styled like the in-list YOU highlight so a
          driver outside the top-N still sees where they stand. */}
      {!loading && !(error && members.length === 0) && showMyRank && myRank && (
        <View
          style={styles.myRankBar}
          accessibilityLabel={`Your rank: ${myRank.rank}, ${formatValue(myRank.value, activeMetric)}`}
        >
          <View style={styles.myRankCircle}>
            <Text style={styles.myRankNumber} numberOfLines={1}>#{myRank.rank}</Text>
          </View>
          <View style={styles.memberInfo}>
            <View style={styles.nameRow}>
              <Text style={styles.displayName} numberOfLines={1}>
                Your rank
              </Text>
              <View style={styles.youBadge}>
                <Text style={styles.youBadgeText}>YOU</Text>
              </View>
            </View>
          </View>
          <Text style={styles.statValue} numberOfLines={1}>
            {formatValue(myRank.value, activeMetric)}
          </Text>
        </View>
      )}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(
  colors: ThemeColors,
  spacing: { xs: number; sm: number; md: number; lg: number; xl: number; xxl: number },
  radius: { sm: number; md: number; lg: number; xl: number; pill: number },
  typography: Record<string, { fontSize: number; fontWeight: '900' | '700' | '400' | '600'; letterSpacing?: number }>,
) {
  return StyleSheet.create({
    // Layout
    container: {
      flex: 1,
      backgroundColor: colors.bg,
    },

    // Header
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.md,
      paddingTop: spacing.md,
      paddingBottom: spacing.sm,
    },
    backButton: {
      flexDirection: 'row',
      alignItems: 'center',
      minWidth: 60,
    },
    backButtonText: {
      color: colors.accent,
      fontSize: 17,
      fontWeight: '600',
      marginLeft: 2,
    },
    headerTitle: {
      flex: 1,
      color: colors.text,
      ...typography.heading,
      textAlign: 'center',
    },
    headerSpacer: {
      minWidth: 60,
    },

    // Tabs
    tabsScroll: {
      flexGrow: 0,
      marginBottom: spacing.sm,
    },
    tabsContent: {
      paddingHorizontal: spacing.md,
      gap: spacing.sm,
      paddingBottom: spacing.sm,
    },
    tab: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs + 2,
      borderRadius: radius.pill,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
    },
    tabActive: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
    tabLabel: {
      color: colors.textMuted,
      ...typography.label,
    },
    tabLabelActive: {
      color: colors.text,
    },

    // List
    list: {
      paddingHorizontal: spacing.md,
      paddingBottom: spacing.xl,
    },
    listEmpty: {
      flex: 1,
      paddingHorizontal: spacing.md,
    },
    errorBanner: {
      color: colors.error,
      fontSize: 12,
      textAlign: 'center',
      marginBottom: spacing.sm,
    },

    // Skeleton
    skeletonList: {
      paddingHorizontal: spacing.md,
      paddingTop: spacing.xs,
      gap: spacing.sm,
    },
    skeletonWrapper: {
      backgroundColor: colors.card,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
    },

    // Row
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.card,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: 10,
      paddingVertical: 14,
      paddingHorizontal: spacing.md,
      gap: spacing.sm,
      overflow: 'hidden',
    },
    rowFirst: {
      borderLeftColor: colors.accent,
      borderLeftWidth: 3,
    },
    // The signed-in user's own row — subtle accent tint + "YOU" badge so a
    // driver can find themself in the rankings at a glance.
    rowYou: {
      backgroundColor: withAlpha(colors.accent, 0.08),
      borderColor: withAlpha(colors.accent, 0.45),
    },
    nameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    youBadge: {
      backgroundColor: colors.accent,
      borderRadius: radius.pill,
      paddingHorizontal: 6,
      paddingVertical: 1,
      flexShrink: 0,
    },
    youBadgeText: {
      color: '#FFFFFF',
      fontSize: 9,
      fontWeight: '800',
      letterSpacing: 0.8,
    },

    // Pinned "your rank" bar (user outside the visible top-N)
    myRankBar: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: withAlpha(colors.accent, 0.08),
      borderTopWidth: 1,
      borderTopColor: withAlpha(colors.accent, 0.45),
      paddingVertical: 14,
      paddingHorizontal: spacing.md,
      gap: spacing.sm,
      minHeight: 56,
    },
    // Rank pill sized to fit 3+ digit ranks (unlike the fixed 28px rankCircle)
    myRankCircle: {
      backgroundColor: colors.accent,
      borderRadius: radius.pill,
      minWidth: 36,
      height: 28,
      paddingHorizontal: 8,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    myRankNumber: {
      color: '#FFFFFF',
      fontSize: 12,
      fontWeight: '700',
    },

    // Rank badge
    rankBadge: {
      width: 36,
      alignItems: 'center',
      flexShrink: 0,
    },
    rankMedal: {
      fontSize: 22,
    },
    rankCircle: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rankNumber: {
      color: colors.textMuted,
      fontSize: 12,
      fontWeight: '700',
    },

    // Avatar
    avatar: {
      width: 40,
      height: 40,
      borderRadius: 20,
      flexShrink: 0,
    },
    avatarFallback: {
      backgroundColor: colors.accentMuted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarInitials: {
      color: colors.text,
      fontSize: 13,
      fontWeight: '700',
      letterSpacing: 0.5,
    },

    // Member info
    memberInfo: {
      flex: 1,
      gap: 3,
    },
    displayName: {
      color: colors.text,
      ...typography.label,
      fontSize: 15,
      flexShrink: 1,
    },
    callsign: {
      color: colors.textMuted,
      ...typography.caption,
    },

    // Stat
    statValue: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '700',
      flexShrink: 0,
      textAlign: 'right',
      maxWidth: 100,
    },

    // Empty state
    emptyState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: 80,
      paddingHorizontal: spacing.xl,
    },
    emptyEmoji: {
      fontSize: 64,
      marginBottom: spacing.md,
    },
    emptyTitle: {
      color: colors.text,
      ...typography.heading,
      marginBottom: spacing.sm,
      textAlign: 'center',
    },
    emptySubtitle: {
      color: colors.textMuted,
      ...typography.body,
      textAlign: 'center',
      lineHeight: 24,
    },
  });
}

type Styles = ReturnType<typeof createStyles>;
