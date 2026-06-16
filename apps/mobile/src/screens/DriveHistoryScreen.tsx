/**
 * DriveHistoryScreen — browse and share past drive records.
 * Requirements: 19.3–19.6
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { apiClient } from '../services/apiClient';

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
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Stat tile
// ---------------------------------------------------------------------------

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statBox}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
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
  sharing: boolean;
}

function DriveDetail({ drive, onBack, onShare, sharing }: DetailProps) {
  return (
    <View style={styles.detail}>
      <TouchableOpacity style={styles.backBtn} onPress={onBack}>
        <Text style={styles.backText}>Back</Text>
      </TouchableOpacity>

      <Text style={styles.detailTitle}>Drive Summary</Text>
      <Text style={styles.detailDate}>{formatDate(drive.endedAt)}</Text>

      <View style={styles.mapPlaceholder}>
        <Text style={styles.mapPlaceholderText}>Route map</Text>
      </View>

      <View style={styles.statsGrid}>
        <Stat label="Distance" value={formatDistance(drive.distanceM)} />
        <Stat label="Duration" value={formatDuration(drive.durationS)} />
        <Stat label="Avg Speed" value={drive.avgSpeedKph ? `${drive.avgSpeedKph.toFixed(0)} km/h` : '—'} />
        <Stat label="Top Speed" value={drive.topSpeedKph ? `${drive.topSpeedKph.toFixed(0)} km/h` : '—'} />
        <Stat label="Members" value={String(drive.memberCount)} />
      </View>

      <TouchableOpacity
        style={[styles.shareBtn, sharing && styles.shareBtnDisabled]}
        onPress={() => onShare(drive.id)}
        disabled={sharing}
      >
        {sharing ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.shareBtnText}>Share Summary Card</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen (Req 19.3)
// ---------------------------------------------------------------------------

export default function DriveHistoryScreen() {
  const [drives, setDrives] = useState<DriveRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [selected, setSelected] = useState<DriveRecord | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);

  const fetchDrives = useCallback(async (pageNum: number, replace: boolean) => {
    try {
      const res = await apiClient.get<{
        drives: DriveRecord[];
        pagination: { pages: number };
      }>(`/api/v1/drives?page=${pageNum}&limit=20`);
      setDrives((prev) => (replace ? res.data.drives : [...prev, ...res.data.drives]));
      setHasMore(pageNum < res.data.pagination.pages);
    } catch {
      Alert.alert('Error', 'Could not load drive history.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchDrives(1, true); }, [fetchDrives]);

  const loadMore = useCallback(() => {
    if (!hasMore || loading) return;
    const next = page + 1;
    setPage(next);
    void fetchDrives(next, false);
  }, [hasMore, loading, page, fetchDrives]);

  const handleShare = useCallback(async (driveId: string) => {
    setSharingId(driveId);
    try {
      const res = await apiClient.post<{ summaryCardUrl: string }>(
        `/api/v1/drives/${driveId}/summary-card`,
      );
      const { summaryCardUrl } = res.data;
      await Share.share({ url: summaryCardUrl, message: 'Check out my CONVOY drive!' });
      setDrives((prev) => prev.map((d) => (d.id === driveId ? { ...d, summaryCardUrl } : d)));
    } catch {
      Alert.alert('Error', 'Could not generate summary card.');
    } finally {
      setSharingId(null);
    }
  }, []);

  if (selected) {
    return (
      <DriveDetail
        drive={selected}
        onBack={() => setSelected(null)}
        onShare={handleShare}
        sharing={sharingId === selected.id}
      />
    );
  }

  if (loading && drives.length === 0) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#3b82f6" size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.screenTitle}>Drive History</Text>
      <FlatList
        data={drives}
        keyExtractor={(d) => d.id}
        contentContainerStyle={styles.list}
        onEndReached={loadMore}
        onEndReachedThreshold={0.3}
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            No drives yet — start a convoy to record your first drive!
          </Text>
        }
        renderItem={({ item: drive }) => (
          <TouchableOpacity
            style={styles.driveCard}
            onPress={() => setSelected(drive)}
          >
            <View style={styles.driveHeader}>
              <Text style={styles.driveDate}>{formatDate(drive.endedAt)}</Text>
              <TouchableOpacity
                style={styles.shareIcon}
                onPress={() => void handleShare(drive.id)}
                disabled={sharingId === drive.id}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                {sharingId === drive.id
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={styles.shareIconText}>share</Text>
                }
              </TouchableOpacity>
            </View>
            <View style={styles.chipRow}>
              <Text style={styles.chip}>{formatDistance(drive.distanceM)}</Text>
              <Text style={styles.chip}>{formatDuration(drive.durationS)}</Text>
              {drive.avgSpeedKph != null && (
                <Text style={styles.chip}>{drive.avgSpeedKph.toFixed(0)} km/h avg</Text>
              )}
              <Text style={styles.chip}>{drive.memberCount} members</Text>
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0f172a' },
  screenTitle: { color: '#f1f5f9', fontSize: 22, fontWeight: '700', padding: 16, paddingBottom: 8 },
  list: { paddingHorizontal: 16, paddingBottom: 20 },
  emptyText: { color: '#64748b', textAlign: 'center', marginTop: 48, fontSize: 14, lineHeight: 22 },

  driveCard: {
    backgroundColor: '#1e293b', borderRadius: 12, padding: 14,
    marginBottom: 10, borderWidth: 1, borderColor: '#334155',
  },
  driveHeader: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: 8,
  },
  driveDate: { color: '#cbd5e1', fontSize: 14, fontWeight: '600' },
  shareIcon: {
    minWidth: 44, minHeight: 44, borderRadius: 8,
    backgroundColor: '#3b82f6', paddingHorizontal: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  shareIconText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    backgroundColor: '#334155', color: '#94a3b8',
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 6, fontSize: 12,
  },

  // Detail
  detail: { flex: 1, backgroundColor: '#0f172a', padding: 16 },
  backBtn: { marginBottom: 16, minHeight: 44, justifyContent: 'center' },
  backText: { color: '#3b82f6', fontSize: 16 },
  detailTitle: { color: '#f1f5f9', fontSize: 22, fontWeight: '700', marginBottom: 4 },
  detailDate: { color: '#64748b', fontSize: 13, marginBottom: 16 },
  mapPlaceholder: {
    height: 180, backgroundColor: '#1e293b', borderRadius: 12,
    alignItems: 'center', justifyContent: 'center', marginBottom: 16,
    borderWidth: 1, borderColor: '#334155',
  },
  mapPlaceholderText: { color: '#64748b', fontSize: 14 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 24 },
  statBox: {
    flex: 1, minWidth: '40%', backgroundColor: '#1e293b', borderRadius: 10,
    padding: 14, alignItems: 'center', borderWidth: 1, borderColor: '#334155',
  },
  statValue: { color: '#f1f5f9', fontSize: 20, fontWeight: '700', marginBottom: 4 },
  statLabel: { color: '#64748b', fontSize: 12 },
  shareBtn: {
    backgroundColor: '#3b82f6', paddingVertical: 14,
    borderRadius: 12, alignItems: 'center', minHeight: 44,
  },
  shareBtnDisabled: { opacity: 0.6 },
  shareBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
