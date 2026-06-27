/**
 * GroupLeaderboardScreen — ranked member stats within a group.
 *
 * Three metric tabs: Distance | Convoys | Time
 * API: GET /api/v1/groups/{groupId}/leaderboard?metric=distance&limit=20
 */

import React, { useCallback, useEffect, useState } from 'react';
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
import { SkeletonRow } from '../components/SkeletonLoader';
import { apiClient } from '../services/apiClient';
import { theme } from '../theme';

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

function Avatar({ uri, name }: { uri?: string; name: string }) {
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

function RankBadge({ rank }: { rank: number }) {
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
}: {
  member: LeaderboardMember;
  rank: number;
  metric: Metric;
}) {
  const isFirst = rank === 1;

  return (
    <View style={[styles.row, isFirst && styles.rowFirst]}>
      <RankBadge rank={rank} />
      <Avatar uri={member.avatarUrl ?? undefined} name={member.displayName} />
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

function Header({ onBack }: { onBack: () => void }) {
  return (
    <View style={styles.header}>
      <TouchableOpacity
        onPress={onBack}
        hitSlop={theme.hitSlop}
        accessibilityRole="button"
        accessibilityLabel="Go back"
      >
        <Text style={styles.backButton}>‹ Back</Text>
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
}: {
  active: Metric;
  onChange: (m: Metric) => void;
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

  // ------------------------------------------------------------------
  // Loading skeleton
  // ------------------------------------------------------------------
  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <Header onBack={handleBack} />
        <MetricTabs active={activeMetric} onChange={handleTabChange} />
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
      <Header onBack={handleBack} />
      <MetricTabs active={activeMetric} onChange={handleTabChange} />

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
            tintColor={theme.colors.accent}
            colors={[theme.colors.accent]}
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
        renderItem={({ item, index }) => (
          <MemberRow member={item} rank={index + 1} metric={activeMetric} />
        )}
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  // Layout
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
  },
  backButton: {
    color: theme.colors.accent,
    fontSize: 17,
    fontWeight: '600',
    minWidth: 60,
  },
  headerTitle: {
    flex: 1,
    color: theme.colors.text,
    ...theme.typography.heading,
    textAlign: 'center',
  },
  headerSpacer: {
    minWidth: 60,
  },

  // Tabs
  tabsScroll: {
    flexGrow: 0,
    marginBottom: theme.spacing.sm,
  },
  tabsContent: {
    paddingHorizontal: theme.spacing.md,
    gap: theme.spacing.sm,
    paddingBottom: theme.spacing.sm,
  },
  tab: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs + 2,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.card,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  tabActive: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  tabLabel: {
    color: theme.colors.textMuted,
    ...theme.typography.label,
  },
  tabLabelActive: {
    color: theme.colors.text,
  },

  // List
  list: {
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.xl,
  },
  listEmpty: {
    flex: 1,
    paddingHorizontal: theme.spacing.md,
  },

  // Skeleton
  skeletonList: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.xs,
    gap: theme.spacing.sm,
  },
  skeletonWrapper: {
    backgroundColor: theme.colors.card,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
  },

  // Row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.card,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: 10,
    paddingVertical: 14,
    paddingHorizontal: theme.spacing.md,
    gap: theme.spacing.sm,
    overflow: 'hidden',
  },
  rowFirst: {
    borderLeftColor: theme.colors.accent,
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
    backgroundColor: theme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rankNumber: {
    color: theme.colors.textMuted,
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
    backgroundColor: theme.colors.accentMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: {
    color: theme.colors.text,
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
    color: theme.colors.text,
    ...theme.typography.label,
    fontSize: 15,
  },
  callsign: {
    color: theme.colors.textMuted,
    ...theme.typography.caption,
  },

  // Stat
  statValue: {
    color: theme.colors.text,
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
    paddingHorizontal: theme.spacing.xl,
  },
  emptyEmoji: {
    fontSize: 64,
    marginBottom: theme.spacing.md,
  },
  emptyTitle: {
    color: theme.colors.text,
    ...theme.typography.heading,
    marginBottom: theme.spacing.sm,
    textAlign: 'center',
  },
  emptySubtitle: {
    color: theme.colors.textMuted,
    ...theme.typography.body,
    textAlign: 'center',
    lineHeight: 24,
  },
});
