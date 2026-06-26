/**
 * LeaderboardScreen — ranked member drive stats within a group.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import SkeletonCard from '../components/SkeletonLoader';
import { apiClient } from '../services/apiClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LeaderboardEntry {
  rank: number;
  displayName: string;
  callsign: string | null;
  driveCount: number;
  totalDistanceKm: number;
  lastDriveAt: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RANK_MEDALS: Record<number, string> = {
  1: '🥇',
  2: '🥈',
  3: '🥉',
};

const RANK_BORDER_COLORS: Record<number, string> = {
  1: '#DC143C', // crimson
  2: '#F59E0B', // amber
  3: '#888888', // grey
};

function formatDistance(km: number): string {
  if (km >= 1000) return `${(km / 1000).toFixed(1)}k km`;
  return `${km.toFixed(1)} km`;
}

function formatLastDrive(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

function LeaderboardRow({ entry }: { entry: LeaderboardEntry }) {
  const isTop3 = entry.rank <= 3;
  const borderColor = isTop3 ? RANK_BORDER_COLORS[entry.rank] : 'transparent';
  const medal = RANK_MEDALS[entry.rank];
  const lastDriveLabel = formatLastDrive(entry.lastDriveAt);

  return (
    <View style={[styles.row, isTop3 && { borderLeftColor: borderColor, borderLeftWidth: 3 }]}>
      {/* Rank number */}
      <View style={styles.rankContainer}>
        <Text style={[styles.rankText, isTop3 && styles.rankTextTop3]}>
          {entry.rank}
        </Text>
      </View>

      {/* Name + callsign */}
      <View style={styles.nameContainer}>
        <Text style={styles.displayName} numberOfLines={1}>
          {medal ? `${medal} ` : ''}{entry.displayName}
        </Text>
        {entry.callsign ? (
          <Text style={styles.callsign} numberOfLines={1}>{entry.callsign}</Text>
        ) : null}
        {lastDriveLabel ? (
          <Text style={styles.lastDrive}>Last drive: {lastDriveLabel}</Text>
        ) : null}
      </View>

      {/* Stats */}
      <View style={styles.statsContainer}>
        <Text style={styles.distance}>{formatDistance(entry.totalDistanceKm)}</Text>
        <Text style={styles.driveCount}>
          {entry.driveCount} {entry.driveCount === 1 ? 'drive' : 'drives'}
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function LeaderboardScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ groupId: string; groupName: string }>();
  const groupId = params.groupId ?? '';
  const groupName = params.groupName ?? 'Group';

  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchLeaderboard = useCallback(async () => {
    try {
      const res = await apiClient.get<{ leaderboard: LeaderboardEntry[] }>(
        `/api/v1/groups/${groupId}/leaderboard`,
      );
      setLeaderboard(res.data.leaderboard);
    } catch {
      // Silently fail — list stays empty or stale
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchLeaderboard();
    setRefreshing(false);
  }, [fetchLeaderboard]);

  useEffect(() => {
    void fetchLeaderboard();
  }, [fetchLeaderboard]);

  // Loading skeleton
  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Text style={styles.backButton}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Leaderboard</Text>
          <View style={styles.headerRight} />
        </View>
        <View style={styles.skeletonPad}>
          {[0, 1, 2, 3, 4].map((i) => <SkeletonCard key={i} />)}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text style={styles.backButton}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Leaderboard</Text>
        <View style={styles.headerRight} />
      </View>

      {groupName ? (
        <Text style={styles.groupName} numberOfLines={1}>{groupName}</Text>
      ) : null}

      <FlatList
        data={leaderboard}
        keyExtractor={(item) => String(item.rank)}
        contentContainerStyle={leaderboard.length === 0 ? styles.listEmpty : styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { void handleRefresh(); }}
            tintColor="#DC143C"
            colors={['#DC143C']}
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyEmoji}>🏁</Text>
            <Text style={styles.emptyText}>
              {'No drives yet\nStart a convoy to appear on the leaderboard!'}
            </Text>
          </View>
        }
        renderItem={({ item }) => <LeaderboardRow entry={item} />}
      />
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
  },
  backButton: {
    color: '#DC143C',
    fontSize: 16,
    fontWeight: '600',
  },
  headerTitle: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
  headerRight: {
    width: 48, // balance the back button width
  },
  groupName: {
    color: '#888888',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 12,
    paddingHorizontal: 16,
  },
  skeletonPad: {
    padding: 16,
    paddingTop: 8,
  },
  list: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  listEmpty: {
    flex: 1,
    paddingHorizontal: 16,
  },

  // Row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    marginBottom: 10,
    paddingVertical: 14,
    paddingHorizontal: 14,
    gap: 12,
    overflow: 'hidden',
  },
  rankContainer: {
    width: 32,
    alignItems: 'center',
    flexShrink: 0,
  },
  rankText: {
    color: '#888888',
    fontSize: 15,
    fontWeight: '700',
  },
  rankTextTop3: {
    color: '#FFFFFF',
    fontSize: 16,
  },
  nameContainer: {
    flex: 1,
    gap: 2,
  },
  displayName: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  callsign: {
    color: '#888888',
    fontSize: 12,
    fontWeight: '500',
  },
  lastDrive: {
    color: '#555555',
    fontSize: 11,
    marginTop: 2,
  },
  statsContainer: {
    alignItems: 'flex-end',
    gap: 2,
    flexShrink: 0,
  },
  distance: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
  driveCount: {
    color: '#888888',
    fontSize: 12,
  },

  // Empty state
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
    paddingHorizontal: 32,
  },
  emptyEmoji: {
    fontSize: 64,
    marginBottom: 16,
  },
  emptyText: {
    color: '#888888',
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 24,
  },
});
