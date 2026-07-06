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
import { apiClient } from '../services/apiClient';
import { ThemeColors, useTheme } from '../theme';

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
  styles,
}: {
  member: LeaderboardMember;
  rank: number;
  metric: Metric;
  styles: Styles;
}) {
  const isFirst = rank === 1;

  return (
    <View style={[styles.row, isFirst && styles.rowFirst]}>
      <RankBadge rank={rank} styles={styles} />
      <Avatar uri={member.avatarUrl ?? undefined} name={member.displayName} styles={styles} />
      <View style={styles.memberInfo}>
        <Text style={styles.displayName} numberOfLines={1}>
          {member.displayName}
        </Text>
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

  const [activeMetric, setActiveMetric] = useState<Metric>('distance');
  const [members, setMembers] = useState<LeaderboardMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchLeaderboard = useCallback(
    async (metric: Metric) => {
      try {
        const res = await apiClient.get<LeaderboardResponse>(
          `/api/v1/groups/${groupId}/leaderboard`,
          { params: { metric, limit: 20 } },
        );
        setMembers(res.data.leaderboard ?? []);
      } catch {
        // Silently fail — list stays empty or stale
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
      <MemberRow member={item} rank={index + 1} metric={activeMetric} styles={styles} />
    ),
    [activeMetric, styles],
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
  return (
    <SafeAreaView style={styles.container}>
      <Header onBack={handleBack} styles={styles} colors={colors} hitSlop={hitSlop} />
      <MetricTabs active={activeMetric} onChange={handleTabChange} styles={styles} />

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
