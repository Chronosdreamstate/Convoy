import React, { useCallback, useEffect, useState } from 'react';
import {
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
import { apiClient } from '../services/apiClient';
import SkeletonCard, { SkeletonBox } from '../components/SkeletonLoader';
import { NetworkError } from '../components/NetworkError';

interface TopMember {
  userId: string;
  displayName: string;
  callsign: string | null;
  drivesCount: number;
  distanceKm: number;
}

interface MonthlyDrive {
  month: string;
  count: number;
}

interface GroupStats {
  groupName: string;
  totalDriveKm: number;
  totalDrives: number;
  totalMembers: number;
  avgConvoyDurationMin: number;
  longestConvoyKm: number;
  topMembers: TopMember[];
  monthlyDrives: MonthlyDrive[];
}

const RANK_COLORS: Record<number, string> = {
  1: '#FFD700',
  2: '#C0C0C0',
  3: '#CD7F32',
};

function RankCircle({ rank }: { rank: number }) {
  const bg = RANK_COLORS[rank] ?? '#2A2A2A';
  return (
    <View style={[styles.rankCircle, { backgroundColor: bg }]}>
      <Text style={[styles.rankText, rank <= 3 ? { color: '#000' } : { color: '#fff' }]}>
        {rank}
      </Text>
    </View>
  );
}

function BarChart({ data }: { data: MonthlyDrive[] }) {
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <View style={styles.chartContainer}>
      {data.map((d) => (
        <View key={d.month} style={styles.barWrapper}>
          <Text style={styles.barCount}>{d.count}</Text>
          <View style={[styles.bar, { height: Math.max(4, (d.count / max) * 80) }]} />
          <Text style={styles.barLabel}>{d.month.slice(0, 3)}</Text>
        </View>
      ))}
    </View>
  );
}

export default function GroupStatsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [stats, setStats] = useState<GroupStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const r = await apiClient.get<GroupStats>(`/api/v1/groups/${id}/stats`);
      setStats(r.data);
    } catch {
      setError('Could not load stats.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  const handleShare = () => {
    if (!stats) return;
    Share.share({
      message: `Our crew has driven ${stats.totalDriveKm.toFixed(0)} km together in ${stats.totalDrives} convoys! 🏁 convoy.app`,
    });
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
            <Text style={styles.backText}>‹ Back</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Group Stats</Text>
          <View style={styles.backBtn} />
        </View>
        <View style={styles.skeletonPad}>
          <View style={styles.skeletonRow}>
            {[0, 1, 2].map((i) => (
              <View key={i} style={styles.skeletonBigCard}>
                <SkeletonBox height={32} width="60%" />
                <SkeletonBox height={12} width="80%" />
              </View>
            ))}
          </View>
          {[0, 1, 2, 3].map((i) => <SkeletonCard key={i} />)}
        </View>
      </SafeAreaView>
    );
  }

  if (error || !stats) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
            <Text style={styles.backText}>‹ Back</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Group Stats</Text>
          <View style={styles.backBtn} />
        </View>
        <NetworkError onRetry={() => { setLoading(true); void load(); }} message={error ?? 'No stats available.'} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{stats.groupName}</Text>
        <TouchableOpacity style={styles.backBtn} onPress={handleShare}>
          <Text style={styles.shareIcon}>📤</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#DC143C" colors={['#DC143C']} />
        }
      >
        {/* Big 3 stats */}
        <View style={styles.bigRow}>
          <View style={styles.bigCard}>
            <Text style={styles.bigValue}>{stats.totalDrives}</Text>
            <Text style={styles.bigLabel}>Total Drives</Text>
          </View>
          <View style={styles.bigCard}>
            <Text style={styles.bigValue}>{stats.totalDriveKm.toFixed(0)}</Text>
            <Text style={styles.bigLabel}>km Driven</Text>
          </View>
          <View style={styles.bigCard}>
            <Text style={styles.bigValue}>{stats.totalMembers}</Text>
            <Text style={styles.bigLabel}>Members</Text>
          </View>
        </View>

        {/* Secondary stats */}
        <View style={styles.secondaryRow}>
          <View style={styles.secondaryCard}>
            <Text style={styles.secondaryValue}>{stats.longestConvoyKm.toFixed(1)} km</Text>
            <Text style={styles.secondaryLabel}>Longest convoy</Text>
          </View>
          <View style={styles.secondaryCard}>
            <Text style={styles.secondaryValue}>{Math.round(stats.avgConvoyDurationMin)} min</Text>
            <Text style={styles.secondaryLabel}>Avg duration</Text>
          </View>
        </View>

        {/* Top Drivers leaderboard */}
        {stats.topMembers.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>🏆 TOP DRIVERS</Text>
            {stats.topMembers.map((m, i) => (
              <View key={m.userId} style={styles.leaderRow}>
                <RankCircle rank={i + 1} />
                <View style={styles.leaderInfo}>
                  <Text style={styles.leaderName}>{m.displayName}</Text>
                  {m.callsign ? <Text style={styles.leaderCallsign}>{m.callsign}</Text> : null}
                </View>
                <View style={styles.leaderStats}>
                  <Text style={styles.leaderDistance}>{m.distanceKm.toFixed(0)} km</Text>
                  <Text style={styles.leaderDrives}>{m.drivesCount} drives</Text>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Monthly activity chart */}
        {stats.monthlyDrives.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>📈 MONTHLY ACTIVITY</Text>
            <BarChart data={stats.monthlyDrives} />
          </View>
        )}

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12,
  },
  backBtn: { minWidth: 48, paddingVertical: 8 },
  backText: { color: '#DC143C', fontSize: 16 },
  shareIcon: { fontSize: 18, textAlign: 'right' },
  title: { flex: 1, color: '#FFFFFF', fontSize: 18, fontWeight: '700', textAlign: 'center' },
  content: { paddingHorizontal: 16, paddingTop: 8 },
  skeletonPad: { paddingHorizontal: 16, paddingTop: 8 },
  skeletonRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  skeletonBigCard: {
    flex: 1, backgroundColor: '#1C1C1C', borderRadius: 12, padding: 14,
    alignItems: 'center', gap: 8,
  },

  bigRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  bigCard: {
    flex: 1, backgroundColor: '#1C1C1C', borderRadius: 12, padding: 14, alignItems: 'center',
  },
  bigValue: { color: '#DC143C', fontSize: 28, fontWeight: '800' },
  bigLabel: { color: '#888888', fontSize: 11, marginTop: 2, textAlign: 'center' },

  secondaryRow: { flexDirection: 'row', gap: 8, marginBottom: 20 },
  secondaryCard: {
    flex: 1, backgroundColor: '#1C1C1C', borderRadius: 10, padding: 12, alignItems: 'center',
  },
  secondaryValue: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  secondaryLabel: { color: '#888888', fontSize: 11, marginTop: 2 },

  section: { marginBottom: 24 },
  sectionLabel: { color: '#888888', fontSize: 11, fontWeight: '600', letterSpacing: 1, marginBottom: 12 },

  leaderRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#1C1C1C',
    borderRadius: 10, padding: 12, marginBottom: 8,
  },
  rankCircle: {
    width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
  },
  rankText: { fontSize: 14, fontWeight: '700' },
  leaderInfo: { flex: 1, marginLeft: 12 },
  leaderName: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  leaderCallsign: { color: '#888888', fontSize: 12, marginTop: 1 },
  leaderStats: { alignItems: 'flex-end' },
  leaderDistance: { color: '#DC143C', fontSize: 14, fontWeight: '700' },
  leaderDrives: { color: '#888888', fontSize: 11, marginTop: 1 },

  chartContainer: {
    flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between',
    backgroundColor: '#1C1C1C', borderRadius: 12, padding: 16, height: 130,
  },
  barWrapper: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  barCount: { color: '#888888', fontSize: 10, marginBottom: 3 },
  bar: { width: 16, backgroundColor: '#DC143C', borderRadius: 3, marginBottom: 6 },
  barLabel: { color: '#888888', fontSize: 10 },

});
