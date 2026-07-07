import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { apiClient } from '../services/apiClient';
import SkeletonCard from '../components/SkeletonLoader';
import { useTheme, ThemeColors } from '../theme';

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

function DriveStat({
  icon,
  label,
  colors,
}: {
  icon: React.ReactNode;
  label: string;
  colors: ThemeColors;
}) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.stat}>
      {icon}
      <Text style={styles.statValue}>{label}</Text>
    </View>
  );
}

function DriveCard({ drive, onReplay }: { drive: ConvoyDrive; onReplay: () => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <View style={styles.routeThumbnail}>
          <Ionicons name="map-outline" size={26} color={colors.textMuted} />
        </View>
        <View style={styles.cardInfo}>
          <Text style={styles.dateText} numberOfLines={1}>{formatDate(drive.startedAt)}</Text>
          <View style={styles.statsRow}>
            <DriveStat
              colors={colors}
              icon={<MaterialCommunityIcons name="map-marker-distance" size={14} color={colors.textMuted} />}
              label={formatDistance(drive.distanceM)}
            />
            <DriveStat
              colors={colors}
              icon={<Ionicons name="time-outline" size={14} color={colors.textMuted} />}
              label={formatDuration(drive.durationS)}
            />
            <DriveStat
              colors={colors}
              icon={<Ionicons name="car-sport-outline" size={14} color={colors.textMuted} />}
              label={`${drive.memberCount} ${drive.memberCount === 1 ? 'car' : 'cars'}`}
            />
          </View>
          {drive.topSpeedKph != null && (
            <Text style={styles.speedText}>Top speed {Math.round(drive.topSpeedKph)} km/h</Text>
          )}
        </View>
      </View>
      <TouchableOpacity
        style={styles.replayBtn}
        onPress={onReplay}
        accessibilityRole="button"
        accessibilityLabel={`Replay drive from ${formatDate(drive.startedAt)}`}
      >
        <Ionicons name="play" size={14} color={colors.accent} />
        <Text style={styles.replayText}>Replay</Text>
      </TouchableOpacity>
    </View>
  );
}

export default function ConvoyHistoryScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { groupId, groupName } = useLocalSearchParams<{ groupId: string; groupName?: string }>();
  const router = useRouter();
  const [drives, setDrives] = useState<ConvoyDrive[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  const fetchDrives = useCallback(async () => {
    if (!groupId) {
      setLoading(false);
      return;
    }
    try {
      const res = await apiClient.get<{ drives: ConvoyDrive[] }>(`/api/v1/groups/${groupId}/drives`);
      setDrives(res.data.drives);
      setError(false);
    } catch {
      setError(true);
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

  const onRetry = useCallback(() => {
    setLoading(true);
    setError(false);
    void fetchDrives();
  }, [fetchDrives]);

  const renderDriveItem = useCallback(
    ({ item }: { item: ConvoyDrive }) => (
      <DriveCard
        drive={item}
        onReplay={() => router.push({ pathname: '/replay', params: { driveId: item.id } } as never)}
      />
    ),
    [router],
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={20} color={colors.accent} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          <Text style={styles.title} numberOfLines={1}>Past Convoys</Text>
          {groupName ? <Text style={styles.subtitle} numberOfLines={1}>{groupName}</Text> : null}
        </View>
        <View style={styles.backBtn} />
      </View>

      {loading ? (
        <View style={styles.skeletonContainer}>
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </View>
      ) : error ? (
        <View style={styles.stateContainer} accessibilityRole="alert">
          <Ionicons name="cloud-offline-outline" size={52} color={colors.textMuted} style={styles.stateIcon} />
          <Text style={styles.stateTitle}>Couldn't load convoys</Text>
          <Text style={styles.stateBody}>Check your connection and try again.</Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel="Retry loading convoys"
          >
            <Ionicons name="refresh" size={16} color={colors.accent} />
            <Text style={styles.retryText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={drives}
          keyExtractor={item => item.id}
          contentContainerStyle={drives.length === 0 ? styles.listEmpty : styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} />
          }
          renderItem={renderDriveItem}
          ListEmptyComponent={
            <View style={styles.empty}>
              <MaterialCommunityIcons name="flag-checkered" size={56} color={colors.textMuted} style={styles.emptyIcon} />
              <Text style={styles.emptyTitle}>No convoys yet</Text>
              <Text style={styles.emptyBody}>
                Once this group finishes a drive together, it'll show up here with the route, distance, and stats.
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8,
  },
  backBtn: {
    width: 72,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  backText: { color: colors.accent, fontSize: 17 },
  headerTitleWrap: { flex: 1, alignItems: 'center' },
  title: { color: colors.text, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  subtitle: { color: colors.textMuted, fontSize: 13, textAlign: 'center', marginTop: 2 },
  skeletonContainer: { padding: 16, gap: 12 },
  list: { padding: 16, gap: 12 },
  listEmpty: { flexGrow: 1, padding: 16 },
  card: {
    backgroundColor: colors.card, borderRadius: 12, padding: 14,
    borderWidth: 0.5, borderColor: colors.border,
  },
  cardTop: { flexDirection: 'row', gap: 12 },
  routeThumbnail: {
    width: 80, height: 60, backgroundColor: colors.cardElevated, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  cardInfo: { flex: 1, justifyContent: 'center' },
  dateText: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: 6 },
  statsRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 14, marginBottom: 4 },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statValue: { color: colors.text, fontSize: 13, fontWeight: '600' },
  speedText: { color: colors.textMuted, fontSize: 12 },
  replayBtn: {
    marginTop: 12, backgroundColor: colors.cardElevated, borderRadius: 8,
    minHeight: 44,
    flexDirection: 'row', gap: 6,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.accent,
  },
  replayText: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  stateContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, paddingBottom: 40 },
  stateIcon: { marginBottom: 16 },
  stateTitle: { color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: 8 },
  stateBody: { color: colors.textMuted, fontSize: 14, textAlign: 'center', marginBottom: 20 },
  retryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 20, minHeight: 44, borderRadius: 22,
    borderWidth: 1, borderColor: colors.accent,
  },
  retryText: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, paddingTop: 80 },
  emptyIcon: { marginBottom: 16 },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '700', marginBottom: 8 },
  emptyBody: { color: colors.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 21 },
  });
}
