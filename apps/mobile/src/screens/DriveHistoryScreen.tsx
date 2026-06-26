/**
 * DriveHistoryScreen — browse and share past drive records.
 * Requirements: 19.3–19.6
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
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
import { useRouter } from 'expo-router';
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

type ListItem =
  | { type: 'header'; label: string; key: string }
  | { type: 'drive'; drive: DriveRecord };

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

function dateKey(iso: string): string {
  return iso.substring(0, 10); // YYYY-MM-DD
}

function dateLabel(iso: string): string {
  const now = new Date();
  const today = dateKey(now.toISOString());
  const yesterday = dateKey(new Date(now.getTime() - 86400000).toISOString());
  const key = dateKey(iso);
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function computeRegion(coords: { latitude: number; longitude: number }[]) {
  if (coords.length === 0) return null;
  const lats = coords.map((c) => c.latitude);
  const lngs = coords.map((c) => c.longitude);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const pad = 1.4;
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max((maxLat - minLat) * pad, 0.01),
    longitudeDelta: Math.max((maxLng - minLng) * pad, 0.01),
  };
}

function buildListData(drives: DriveRecord[]): ListItem[] {
  const items: ListItem[] = [];
  let currentKey = '';
  for (const drive of drives) {
    const key = dateKey(drive.endedAt);
    if (key !== currentKey) {
      currentKey = key;
      items.push({ type: 'header', label: dateLabel(drive.endedAt), key });
    }
    items.push({ type: 'drive', drive });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Total stats header
// ---------------------------------------------------------------------------

function TotalStatsHeader({ drives }: { drives: DriveRecord[] }) {
  const totalDistanceM = drives.reduce((sum, d) => sum + d.distanceM, 0);
  return (
    <View style={styles.statsHeader}>
      <View style={styles.statPill}>
        <Text style={styles.statPillValue}>{formatDistance(totalDistanceM)}</Text>
        <Text style={styles.statPillLabel}>Total Distance</Text>
      </View>
      <View style={styles.statPillDivider} />
      <View style={styles.statPill}>
        <Text style={styles.statPillValue}>{drives.length}</Text>
        <Text style={styles.statPillLabel}>Total Drives</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Stat tile (used in detail view)
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
          {formatDate(drive.endedAt)} · {formatTime(drive.startedAt)} → {formatTime(drive.endedAt)}
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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expandAnim = useRef(new Animated.Value(0)).current;
  const router = useRouter();

  const toggleExpand = useCallback((id: string) => {
    if (expandedId === id) {
      Animated.timing(expandAnim, { toValue: 0, duration: 200, useNativeDriver: false }).start(() => {
        setExpandedId(null);
      });
    } else {
      expandAnim.setValue(0);
      setExpandedId(id);
      Animated.timing(expandAnim, { toValue: 204, duration: 220, useNativeDriver: false }).start();
    }
  }, [expandedId, expandAnim]);

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

  const listData = useMemo(() => buildListData(drives), [drives]);

  const longestDriveId = useMemo(() => {
    if (drives.length < 2) return null;
    return drives.reduce((best, d) => (d.distanceM > best.distanceM ? d : best)).id;
  }, [drives]);

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
      </View>

      <FlatList
        data={listData}
        keyExtractor={(item, index) =>
          item.type === 'header' ? `header-${item.key}-${index}` : item.drive.id
        }
        contentContainerStyle={listData.length === 0 ? styles.listEmpty : styles.list}
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
        ListHeaderComponent={drives.length > 0 ? <TotalStatsHeader drives={drives} /> : null}
        ListFooterComponent={loadingMore ? <ActivityIndicator color="#DC143C" style={styles.footerSpinner} /> : null}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyEmoji}>🛣️</Text>
            <Text style={styles.emptyTitle}>No drives recorded yet</Text>
            <Text style={styles.emptySubtitle}>
              Your drive history will appear here after your first convoy.
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          if (item.type === 'header') {
            return (
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionHeaderText}>{item.label}</Text>
              </View>
            );
          }

          const { drive } = item;
          const isLongest = drive.id === longestDriveId;
          const isExpanded = drive.id === expandedId;
          const routeCoords = drive.routeTrace?.coordinates.map(([lng, lat]) => ({
            latitude: lat, longitude: lng,
          })) ?? [];
          const region = computeRegion(routeCoords);

          return (
            <View style={[styles.driveCardOuter, isLongest && styles.driveCardOuterLongest]}>
              {/* ── Main summary row ── */}
              <View style={styles.driveCardMainRow}>
                <TouchableOpacity
                  style={styles.driveCardTouchable}
                  onPress={() => setSelected(drive)}
                  accessibilityRole="button"
                  accessibilityLabel={`Drive on ${formatDate(drive.endedAt)}, ${formatDistance(drive.distanceM)}`}
                >
                  <View style={styles.thumbWrapper}>
                    <MapThumb routeTrace={drive.routeTrace} />
                    {isLongest && (
                      <View style={styles.trophyBadge}>
                        <Text style={styles.trophyText}>🏆</Text>
                      </View>
                    )}
                  </View>
                  <View style={styles.driveCardContent}>
                    <Text style={styles.driveTimeRange}>
                      {formatTime(drive.startedAt)} → {formatTime(drive.endedAt)}
                    </Text>
                    <Text style={styles.driveDistDur}>
                      {formatDistance(drive.distanceM)} · {formatDuration(drive.durationS)}
                      {drive.avgSpeedKph != null ? `  · ${drive.avgSpeedKph.toFixed(0)} km/h avg` : ''}
                    </Text>
                    <Text style={styles.driveMembers}>
                      {drive.groupId
                        ? `👥 Group Drive${drive.memberCount > 1 ? ` · ${drive.memberCount} members` : ''}`
                        : '🚗 Solo Drive'}
                    </Text>
                  </View>
                </TouchableOpacity>

                {/* Chevron — toggles inline expansion */}
                <TouchableOpacity
                  style={styles.chevronBtn}
                  onPress={() => toggleExpand(drive.id)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityRole="button"
                  accessibilityLabel={isExpanded ? 'Collapse details' : 'Expand details'}
                >
                  <Text style={[styles.chevronText, isExpanded && styles.chevronExpanded]}>›</Text>
                </TouchableOpacity>
              </View>

              {/* ── Expandable inline detail ── */}
              {isExpanded && (
                <Animated.View style={[styles.expandPanel, { height: expandAnim }]}>
                  {/* Mini map */}
                  {routeCoords.length > 1 && region ? (
                    <View style={styles.expandMapContainer}>
                      <MapView
                        provider={PROVIDER_DEFAULT}
                        style={StyleSheet.absoluteFillObject}
                        initialRegion={region}
                        scrollEnabled={false}
                        zoomEnabled={false}
                        rotateEnabled={false}
                        pitchEnabled={false}
                      >
                        <Polyline coordinates={routeCoords} strokeColor="#DC143C" strokeWidth={3} />
                      </MapView>
                    </View>
                  ) : (
                    <View style={[styles.expandMapContainer, styles.expandMapPlaceholder]}>
                      <Text style={{ fontSize: 28 }}>🗺</Text>
                    </View>
                  )}

                  {/* Quick stats row */}
                  <View style={styles.expandStatsRow}>
                    {drive.topSpeedKph != null && (
                      <Text style={styles.expandStat}>⚡ {drive.topSpeedKph.toFixed(0)} km/h top</Text>
                    )}
                    {drive.avgSpeedKph != null && (
                      <Text style={styles.expandStat}>📊 {drive.avgSpeedKph.toFixed(0)} km/h avg</Text>
                    )}
                    <Text style={styles.expandStat}>
                      {drive.groupId ? `👥 Group · ${drive.memberCount} members` : '🚗 Solo'}
                    </Text>
                  </View>

                  {/* Action row: Share + Replay */}
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TouchableOpacity
                      style={[styles.expandShareBtn, { flex: 1 }]}
                      onPress={() => void handleShare(drive.id)}
                      disabled={sharingId === drive.id}
                      accessibilityRole="button"
                      accessibilityLabel="Share drive"
                    >
                      {sharingId === drive.id
                        ? <ActivityIndicator color="#DC143C" size="small" />
                        : <Text style={styles.expandShareBtnText}>📤 Share</Text>
                      }
                    </TouchableOpacity>
                    {(drive.routeTrace?.coordinates?.length ?? 0) > 1 && (
                      <TouchableOpacity
                        style={[styles.expandShareBtn, { flex: 1, backgroundColor: '#1C1C1C', borderColor: '#DC143C', borderWidth: 1 }]}
                        onPress={() => router.push(`/replay?driveId=${drive.id}`)}
                        accessibilityRole="button"
                        accessibilityLabel="Replay drive"
                      >
                        <Text style={[styles.expandShareBtnText, { color: '#DC143C' }]}>▶ Replay</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </Animated.View>
              )}
            </View>
          );
        }}
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
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  screenTitle: { color: '#F0F0F0', fontSize: 24, fontWeight: '700' },

  // Total stats header
  statsHeader: {
    flexDirection: 'row',
    backgroundColor: '#1C1C1C',
    borderRadius: 14,
    marginBottom: 16,
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statPill: {
    flex: 1,
    alignItems: 'center',
  },
  statPillValue: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 2,
  },
  statPillLabel: {
    color: '#888888',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  statPillDivider: {
    width: 1,
    height: 36,
    backgroundColor: '#2A2A2A',
    marginHorizontal: 8,
  },

  // Section headers
  sectionHeader: {
    paddingVertical: 6,
    paddingHorizontal: 4,
    marginBottom: 6,
    marginTop: 4,
  },
  sectionHeaderText: {
    color: '#888888',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },

  list: { paddingHorizontal: 16, paddingBottom: 20 },
  listEmpty: { flex: 1, paddingHorizontal: 16 },

  footerSpinner: { paddingVertical: 20 },

  // Empty state
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyEmoji: { fontSize: 64, marginBottom: 16 },
  emptyTitle: { color: '#F0F0F0', fontSize: 20, fontWeight: '700', marginBottom: 8 },
  emptySubtitle: { color: '#888888', fontSize: 14, textAlign: 'center', lineHeight: 22 },

  // Drive card — new expandable structure
  driveCardOuter: {
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    marginBottom: 10,
    overflow: 'hidden',
  },
  driveCardOuterLongest: {
    borderColor: '#DC143C',
    borderWidth: 1.5,
  },
  driveCardMainRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  driveCardTouchable: {
    flex: 1,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 80,
  },
  chevronBtn: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
    borderLeftWidth: 1,
    borderLeftColor: '#2A2A2A',
  },
  chevronText: {
    color: '#555555',
    fontSize: 22,
    fontWeight: '300',
  },
  chevronExpanded: {
    color: '#DC143C',
    transform: [{ rotate: '90deg' }],
  },
  expandPanel: {
    overflow: 'hidden',
    borderTopWidth: 1,
    borderTopColor: '#2A2A2A',
  },
  expandMapContainer: {
    height: 120,
    width: '100%',
    overflow: 'hidden',
  },
  expandMapPlaceholder: {
    backgroundColor: '#0A0A0A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  expandStatsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 6,
  },
  expandStat: {
    color: '#888888',
    fontSize: 12,
    fontWeight: '500',
  },
  expandShareBtn: {
    marginHorizontal: 14,
    marginBottom: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#DC143C',
    alignItems: 'center',
    minHeight: 36,
    justifyContent: 'center',
  },
  expandShareBtnText: {
    color: '#DC143C',
    fontSize: 13,
    fontWeight: '600',
  },

  // Thumbnail + trophy overlay
  thumbWrapper: {
    position: 'relative',
    flexShrink: 0,
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
    overflow: 'hidden',
  },
  mapThumbIcon: { fontSize: 24 },
  trophyBadge: {
    position: 'absolute',
    bottom: -4,
    right: -4,
    backgroundColor: '#0A0A0A',
    borderRadius: 10,
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trophyText: { fontSize: 12 },

  // Card content
  driveCardContent: { flex: 1 },
  driveTimeRange: {
    color: '#888888',
    fontSize: 12,
    marginBottom: 4,
    letterSpacing: 0.2,
  },
  driveDistDur: {
    color: '#F0F0F0',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  driveMembers: { color: '#555555', fontSize: 12 },

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
