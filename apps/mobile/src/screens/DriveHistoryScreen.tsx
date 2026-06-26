/**
 * DriveHistoryScreen — browse and share past drive records.
 * Requirements: 19.3–19.6
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Platform,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import MapView, { Polyline, PROVIDER_DEFAULT } from 'react-native-maps';
import { apiClient } from '../services/apiClient';

const MAPBOX_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';

function buildStaticMapUrl(coords: [number, number][]): string | null {
  if (!MAPBOX_TOKEN || coords.length < 2) return null;
  const step = Math.max(1, Math.floor(coords.length / 25));
  const sampled: [number, number][] = [];
  for (let i = 0; i < coords.length; i += step) sampled.push(coords[i]);
  if (sampled[sampled.length - 1] !== coords[coords.length - 1]) {
    sampled.push(coords[coords.length - 1]);
  }
  const geojson = JSON.stringify({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: sampled },
    properties: { stroke: '#DC143C', 'stroke-width': 3, 'stroke-opacity': 1 },
  });
  return (
    `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/` +
    `geojson(${encodeURIComponent(geojson)})/auto/112x112@2x` +
    `?padding=12&access_token=${MAPBOX_TOKEN}`
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DriveRecord {
  id: string;
  groupId: string | null;
  distanceM: number;
  durationS: number;
  avgSpeedKph: number | null;
  topSpeedKph: number | null;
  memberCount: number;
  startedAt: string;
  endedAt: string;
  summaryCardUrl: string | null;
  routeTrace?: { type: string; coordinates: [number, number][] } | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${m} m`;
}

function formatDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Stat tile
// ---------------------------------------------------------------------------

function Stat({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <View style={styles.statBox}>
      <Text style={styles.statIcon}>{icon}</Text>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Map thumbnail
// ---------------------------------------------------------------------------

function MapThumb({ routeTrace }: { routeTrace?: DriveRecord['routeTrace'] }) {
  const url = routeTrace?.coordinates
    ? buildStaticMapUrl(routeTrace.coordinates)
    : null;

  if (url) {
    return <Image source={{ uri: url }} style={styles.mapThumb} />;
  }
  return (
    <View style={styles.mapThumb}>
      <Text style={styles.mapThumbIcon}>🗺</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Detail view (Req 19.4)
// ---------------------------------------------------------------------------

interface DetailProps {
  drive: DriveRecord;
  onBack: () => void;
  onShare: (id: string) => void;
  onDelete: (id: string) => void;
  sharing: boolean;
  deleting: boolean;
}

function DriveDetail({ drive, onBack, onShare, onDelete, sharing, deleting }: DetailProps) {
  const routeCoords = drive.routeTrace?.coordinates.map(([lng, lat]) => ({
    latitude: lat,
    longitude: lng,
  })) ?? [];

  const midIdx = Math.floor(routeCoords.length / 2);
  const centerLat = routeCoords[midIdx]?.latitude ?? 37.7749;
  const centerLng = routeCoords[midIdx]?.longitude ?? -122.4194;

  return (
    <View style={styles.detail}>
      <TouchableOpacity style={styles.backBtn} onPress={onBack} accessibilityRole="button" accessibilityLabel="Go back">
        <Text style={styles.backText}>← Back</Text>
      </TouchableOpacity>

      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text style={styles.detailTitle}>Drive Summary</Text>
        <Text style={styles.detailDate}>
          {formatDate(drive.endedAt)} · {formatTime(drive.endedAt)}
        </Text>

        {/* Route map */}
        {routeCoords.length > 1 ? (
          <View style={styles.mapPlaceholder}>
            <MapView
              provider={PROVIDER_DEFAULT}
              style={styles.driveMapView}
              initialRegion={{
                latitude: centerLat,
                longitude: centerLng,
                latitudeDelta: 0.15,
                longitudeDelta: 0.15,
              }}
              scrollEnabled={false}
              zoomEnabled={false}
              rotateEnabled={false}
              pitchEnabled={false}
            >
              <Polyline
                coordinates={routeCoords}
                strokeColor="#DC143C"
                strokeWidth={3}
              />
            </MapView>
          </View>
        ) : (
          <View style={styles.mapPlaceholder}>
            <Text style={styles.mapPlaceholderIcon}>🗺</Text>
            <Text style={styles.mapPlaceholderText}>Route map unavailable</Text>
          </View>
        )}

        {/* 2×2 stats grid */}
        <View style={styles.statsGrid}>
          <Stat icon="📍" label="Distance" value={formatDistance(drive.distanceM)} />
          <Stat icon="⏱" label="Duration" value={formatDuration(drive.durationS)} />
          <Stat icon="💨" label="Avg Speed" value={drive.avgSpeedKph ? `${drive.avgSpeedKph.toFixed(0)} km/h` : '—'} />
          <Stat icon="🏎" label="Top Speed" value={drive.topSpeedKph ? `${drive.topSpeedKph.toFixed(0)} km/h` : '—'} />
        </View>

        {drive.memberCount > 0 && (
          <Text style={styles.detailMembers}>👥 {drive.memberCount} member{drive.memberCount !== 1 ? 's' : ''}</Text>
        )}

        <TouchableOpacity
          style={[styles.shareBtn, sharing && styles.shareBtnDisabled]}
          onPress={() => onShare(drive.id)}
          disabled={sharing || deleting}
          accessibilityRole="button"
          accessibilityLabel="Share summary card"
          accessibilityState={{ disabled: sharing || deleting }}
        >
          {sharing ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.shareBtnText}>Share Summary Card</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.deleteBtn, deleting && styles.shareBtnDisabled]}
          onPress={() => onDelete(drive.id)}
          disabled={deleting || sharing}
          accessibilityRole="button"
          accessibilityLabel="Delete drive record"
          accessibilityState={{ disabled: deleting || sharing }}
        >
          {deleting ? (
            <ActivityIndicator color="#DC143C" />
          ) : (
            <Text style={styles.deleteBtnText}>Delete Record</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen (Req 19.3)
// ---------------------------------------------------------------------------

export default function DriveHistoryScreen() {
  const [drives, setDrives] = useState<DriveRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [selected, setSelected] = useState<DriveRecord | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchDrives = useCallback(async (pageNum: number, replace: boolean) => {
    try {
      const res = await apiClient.get<{
        drives: DriveRecord[];
        pagination: { pages: number };
      }>(`/api/v1/drives?page=${pageNum}&limit=20&includeRoute=true`);
      setDrives((prev) => (replace ? res.data.drives : [...prev, ...res.data.drives]));
      setHasMore(pageNum < res.data.pagination.pages);
      if (replace) setPage(1);
    } catch {
      Alert.alert('Error', 'Could not load drive history.');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchDrives(1, true);
    setRefreshing(false);
  }, [fetchDrives]);

  useEffect(() => { void fetchDrives(1, true); }, [fetchDrives]);

  const loadMore = useCallback(() => {
    if (!hasMore || loading || loadingMore) return;
    const next = page + 1;
    setLoadingMore(true);
    void fetchDrives(next, false)
      .then(() => setPage(next))
      .finally(() => setLoadingMore(false));
  }, [hasMore, loading, loadingMore, page, fetchDrives]);

  const handleShare = useCallback(async (driveId: string) => {
    setSharingId(driveId);
    try {
      const res = await apiClient.post<{ summaryCardUrl: string }>(
        `/api/v1/drives/${driveId}/summary-card`,
      );
      const { summaryCardUrl } = res.data;
      setDrives((prev) => prev.map((d) => (d.id === driveId ? { ...d, summaryCardUrl } : d)));
      try {
        await Share.share(
          Platform.OS === 'ios'
            ? { url: summaryCardUrl, message: 'Check out my CONVOY drive!' }
            : { message: `Check out my CONVOY drive! ${summaryCardUrl}` },
        );
      } catch { /* user cancelled the share sheet */ }
    } catch {
      Alert.alert('Error', 'Could not generate summary card.');
    } finally {
      setSharingId(null);
    }
  }, []);

  const handleDelete = useCallback((driveId: string) => {
    Alert.alert(
      'Delete Drive Record',
      'This permanently removes this drive from your history. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeletingId(driveId);
            try {
              await apiClient.delete(`/api/v1/drives/${driveId}`);
              setDrives((prev) => prev.filter((d) => d.id !== driveId));
              setSelected(null);
            } catch {
              Alert.alert('Error', 'Could not delete this drive record. Please try again.');
            } finally {
              setDeletingId(null);
            }
          },
        },
      ],
    );
  }, []);

  if (selected) {
    return (
      <SafeAreaView style={styles.container}>
        <DriveDetail
          drive={selected}
          onBack={() => setSelected(null)}
          onShare={handleShare}
          onDelete={handleDelete}
          sharing={sharingId === selected.id}
          deleting={deletingId === selected.id}
        />
      </SafeAreaView>
    );
  }

  if (loading && drives.length === 0) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <ActivityIndicator color="#DC143C" size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.screenHeader}>
        <Text style={styles.screenTitle}>Drive History</Text>
        <Text style={styles.screenSubtitle}>{drives.length} drive{drives.length !== 1 ? 's' : ''}</Text>
      </View>

      <FlatList
        data={drives}
        keyExtractor={(d) => d.id}
        contentContainerStyle={drives.length === 0 ? styles.listEmpty : styles.list}
        onEndReached={loadMore}
        onEndReachedThreshold={0.3}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { void handleRefresh(); }}
            tintColor="#DC143C"
            colors={['#DC143C']}
          />
        }
        ListFooterComponent={loadingMore ? <ActivityIndicator color="#DC143C" style={styles.footerSpinner} /> : null}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyEmoji}>🛣️</Text>
            <Text style={styles.emptyTitle}>No drives yet</Text>
            <Text style={styles.emptySubtitle}>
              Your drive history will appear here after your first convoy.
            </Text>
          </View>
        }
        renderItem={({ item: drive }) => (
          <View style={styles.driveCardRow}>
            <TouchableOpacity
              style={styles.driveCard}
              onPress={() => setSelected(drive)}
              accessibilityRole="button"
              accessibilityLabel={`Drive on ${formatDate(drive.endedAt)}, ${formatDistance(drive.distanceM)}`}
            >
              {/* Left: map thumbnail */}
              <MapThumb routeTrace={drive.routeTrace} />

              {/* Right: info */}
              <View style={styles.driveCardContent}>
                <View style={styles.driveHeader}>
                  <Text style={styles.driveDate}>{formatDate(drive.endedAt)}</Text>
                  <Text style={styles.driveTime}>{formatTime(drive.endedAt)}</Text>
                </View>

                {/* Stats row */}
                <View style={styles.driveStatsRow}>
                  <View style={styles.driveStat}>
                    <Text style={styles.driveStatIcon}>📍</Text>
                    <Text style={styles.driveStatValue}>{formatDistance(drive.distanceM)}</Text>
                  </View>
                  <View style={styles.driveStat}>
                    <Text style={styles.driveStatIcon}>⏱</Text>
                    <Text style={styles.driveStatValue}>{formatDuration(drive.durationS)}</Text>
                  </View>
                  {drive.avgSpeedKph != null && (
                    <View style={styles.driveStat}>
                      <Text style={styles.driveStatIcon}>💨</Text>
                      <Text style={styles.driveStatValue}>{drive.avgSpeedKph.toFixed(0)} km/h</Text>
                    </View>
                  )}
                </View>

                {drive.memberCount > 1 && (
                  <Text style={styles.driveMembers}>👥 {drive.memberCount} members</Text>
                )}
              </View>
            </TouchableOpacity>

            {/* Share button — outside card touch area to prevent propagation */}
            <TouchableOpacity
              style={styles.shareIcon}
              onPress={() => void handleShare(drive.id)}
              disabled={sharingId === drive.id}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Share drive"
              accessibilityState={{ disabled: sharingId === drive.id }}
            >
              {sharingId === drive.id
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={styles.shareIconText}>↑</Text>
              }
            </TouchableOpacity>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  screenHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  screenTitle: { color: '#F0F0F0', fontSize: 24, fontWeight: '700' },
  screenSubtitle: { color: '#888888', fontSize: 13 },

  list: { paddingHorizontal: 16, paddingBottom: 20 },
  listEmpty: { flex: 1, paddingHorizontal: 16 },

  footerSpinner: { paddingVertical: 20 },

  // Empty state
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyEmoji: { fontSize: 72, marginBottom: 16 },
  emptyTitle: { color: '#F0F0F0', fontSize: 20, fontWeight: '700', marginBottom: 8 },
  emptySubtitle: { color: '#888888', fontSize: 14, textAlign: 'center', lineHeight: 22 },

  // Drive card row + card
  driveCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  driveCard: {
    flex: 1,
    backgroundColor: '#1C1C1C',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 80,
  },
  mapThumb: {
    width: 56,
    height: 56,
    borderRadius: 10,
    backgroundColor: '#0A0A0A',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    flexShrink: 0,
    overflow: 'hidden',
  },
  mapThumbIcon: { fontSize: 24 },

  driveCardContent: { flex: 1 },
  driveHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  driveDate: { color: '#F0F0F0', fontSize: 14, fontWeight: '700' },
  driveTime: { color: '#888888', fontSize: 12 },

  driveStatsRow: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  driveStat: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  driveStatIcon: { fontSize: 11 },
  driveStatValue: { color: '#888888', fontSize: 12, fontWeight: '500' },
  driveMembers: { color: '#555555', fontSize: 12, marginTop: 4 },

  shareIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#DC143C',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  shareIconText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  // Detail
  detail: { flex: 1, backgroundColor: '#0A0A0A', padding: 16 },
  backBtn: { marginBottom: 16, minHeight: 44, justifyContent: 'center' },
  backText: { color: '#DC143C', fontSize: 16, fontWeight: '600' },
  detailTitle: { color: '#F0F0F0', fontSize: 24, fontWeight: '700', marginBottom: 4 },
  detailDate: { color: '#888888', fontSize: 13, marginBottom: 16 },
  detailMembers: { color: '#888888', fontSize: 14, marginBottom: 20 },
  mapPlaceholder: {
    height: 180,
    backgroundColor: '#1C1C1C',
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    gap: 8,
    overflow: 'hidden',
  },
  driveMapView: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 14,
  },
  mapPlaceholderIcon: { fontSize: 40 },
  mapPlaceholderText: { color: '#888888', fontSize: 13 },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 20,
  },
  statBox: {
    flex: 1,
    minWidth: '42%',
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    borderLeftWidth: 2,
    borderLeftColor: '#DC143C',
  },
  statIcon: { fontSize: 22, marginBottom: 6 },
  statValue: { color: '#F0F0F0', fontSize: 20, fontWeight: '700', marginBottom: 4 },
  statLabel: { color: '#555555', fontSize: 12 },
  shareBtn: {
    backgroundColor: '#DC143C',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    minHeight: 52,
  },
  shareBtnDisabled: { opacity: 0.6 },
  shareBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  deleteBtn: {
    marginTop: 12,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#DC143C',
    minHeight: 52,
  },
  deleteBtnText: { color: '#DC143C', fontWeight: '700', fontSize: 16 },
});
