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
import { useLocalSearchParams, useRouter } from 'expo-router';
import { apiClient } from '../services/apiClient';
import SkeletonCard from '../components/SkeletonLoader';

interface ConvoyDrive {
  id: string;
  groupId: string;
  distanceM: number;
  durationS: number;
  avgSpeedKph: number | null;
  topSpeedKph: number | null;
  memberCount: number;
  startedAt: string;
  endedAt: string;
}

function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
}

function formatDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

function DriveCard({ drive, onReplay }: { drive: ConvoyDrive; onReplay: () => void }) {
  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <View style={styles.routeThumbnail}>
          <Text style={styles.thumbnailIcon}>🗺️</Text>
        </View>
        <View style={styles.cardInfo}>
          <Text style={styles.dateText}>{formatDate(drive.startedAt)}</Text>
          <Text style={styles.statsText}>
            {formatDistance(drive.distanceM)} · {formatDuration(drive.durationS)} · {drive.memberCount} cars
          </Text>
          {drive.topSpeedKph != null && (
            <Text style={styles.speedText}>Top speed: {Math.round(drive.topSpeedKph)} km/h</Text>
          )}
        </View>
      </View>
      <TouchableOpacity style={styles.replayBtn} onPress={onReplay} accessibilityLabel="Replay this drive">
        <Text style={styles.replayText}>▶ Replay</Text>
      </TouchableOpacity>
    </View>
  );
}

export default function ConvoyHistoryScreen() {
  const { groupId, groupName } = useLocalSearchParams<{ groupId: string; groupName?: string }>();
  const router = useRouter();
  const [drives, setDrives] = useState<ConvoyDrive[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchDrives = useCallback(async () => {
    if (!groupId) return;
    try {
      const res = await apiClient.get<{ drives: ConvoyDrive[] }>(`/api/v1/groups/${groupId}/drives`);
      setDrives(res.data.drives);
    } catch {
      // silently show empty state
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => { void fetchDrives(); }, [fetchDrives]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchDrives();
    setRefreshing(false);
  }, [fetchDrives]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
        <View>
          <Text style={styles.title}>Past Convoys</Text>
          {groupName ? <Text style={styles.subtitle}>{groupName}</Text> : null}
        </View>
        <View style={{ width: 48 }} />
      </View>

      {loading ? (
        <View style={styles.skeletonContainer}>
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </View>
      ) : (
        <FlatList
          data={drives}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#DC143C" colors={['#DC143C']} />
          }
          renderItem={({ item }) => (
            <DriveCard
              drive={item}
              onReplay={() => router.push({ pathname: '/replay', params: { driveId: item.id } } as never)}
            />
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>🏁</Text>
              <Text style={styles.emptyTitle}>No convoys yet</Text>
              <Text style={styles.emptyBody}>Start your first drive together</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8,
  },
  backText: { color: '#DC143C', fontSize: 18 },
  title: { color: '#FFFFFF', fontSize: 18, fontWeight: '700', textAlign: 'center' },
  subtitle: { color: '#888888', fontSize: 13, textAlign: 'center', marginTop: 2 },
  skeletonContainer: { padding: 16, gap: 12 },
  list: { padding: 16, gap: 12 },
  card: {
    backgroundColor: '#1C1C1C', borderRadius: 12, padding: 14,
    borderWidth: 0.5, borderColor: '#2A2A2A',
  },
  cardTop: { flexDirection: 'row', gap: 12 },
  routeThumbnail: {
    width: 80, height: 60, backgroundColor: '#242424', borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  thumbnailIcon: { fontSize: 28 },
  cardInfo: { flex: 1, justifyContent: 'center' },
  dateText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700', marginBottom: 4 },
  statsText: { color: '#888888', fontSize: 13, marginBottom: 2 },
  speedText: { color: '#888888', fontSize: 12 },
  replayBtn: {
    marginTop: 12, backgroundColor: '#242424', borderRadius: 8,
    paddingVertical: 8, alignItems: 'center',
    borderWidth: 1, borderColor: '#DC143C',
  },
  replayText: { color: '#DC143C', fontSize: 14, fontWeight: '600' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyIcon: { fontSize: 56, marginBottom: 16 },
  emptyTitle: { color: '#FFFFFF', fontSize: 20, fontWeight: '700', marginBottom: 8 },
  emptyBody: { color: '#888888', fontSize: 14 },
});
