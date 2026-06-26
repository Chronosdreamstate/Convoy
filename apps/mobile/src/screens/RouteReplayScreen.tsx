import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { apiClient } from '../services/apiClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Coordinate {
  latitude: number;
  longitude: number;
}

interface DriveDetail {
  id: string;
  routeTrace: { type: string; coordinates: [number, number][] };
  distanceM: number;
  durationS: number;
  avgSpeedKph: number | null;
  topSpeedKph: number | null;
  startedAt: string;
  endedAt: string;
  memberCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDistance(meters: number): string {
  return `${(meters / 1000).toFixed(1)} km`;
}

function geojsonToCoords(coords: [number, number][]): Coordinate[] {
  // GeoJSON is [lng, lat]; MapView needs { latitude, longitude }
  return coords.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
}

function boundingRegion(coords: Coordinate[]) {
  if (coords.length === 0) return undefined;
  const lats = coords.map((c) => c.latitude);
  const lngs = coords.map((c) => c.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max(maxLat - minLat, 0.01) * 1.3,
    longitudeDelta: Math.max(maxLng - minLng, 0.01) * 1.3,
  };
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

const SPEEDS = [1, 2, 5] as const;
type Speed = (typeof SPEEDS)[number];

export default function RouteReplayScreen() {
  const { driveId } = useLocalSearchParams<{ driveId: string }>();
  const router = useRouter();

  const [drive, setDrive] = useState<DriveDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [coords, setCoords] = useState<Coordinate[]>([]);
  const [markerIndex, setMarkerIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressAnim = useRef(new Animated.Value(0)).current;
  const mapRef = useRef<MapView>(null);

  // ── Fetch drive ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!driveId) return;
    setLoading(true);
    apiClient
      .get<DriveDetail>(`/api/v1/drives/${driveId}`)
      .then((res) => {
        setDrive(res.data);
        const c = geojsonToCoords(res.data.routeTrace?.coordinates ?? []);
        setCoords(c);
      })
      .catch(() => setError('Could not load drive data.'))
      .finally(() => setLoading(false));
  }, [driveId]);

  // ── Fit map to route ───────────────────────────────────────────────────────
  useEffect(() => {
    if (coords.length > 0) {
      setTimeout(() => {
        mapRef.current?.fitToCoordinates(coords, {
          edgePadding: { top: 60, right: 40, bottom: 60, left: 40 },
          animated: true,
        });
      }, 400);
    }
  }, [coords]);

  // ── Playback engine ────────────────────────────────────────────────────────
  const stopPlayback = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    setPlaying(false);
  }, []);

  const startPlayback = useCallback(() => {
    if (coords.length === 0) return;
    setPlaying(true);
    intervalRef.current = setInterval(() => {
      setMarkerIndex((prev) => {
        const next = prev + 1;
        if (next >= coords.length) {
          stopPlayback();
          return prev;
        }
        const progress = next / (coords.length - 1);
        progressAnim.setValue(progress);
        return next;
      });
    }, Math.round(50 / speed));
  }, [coords, speed, progressAnim, stopPlayback]);

  const togglePlay = useCallback(() => {
    if (playing) {
      stopPlayback();
    } else {
      if (markerIndex >= coords.length - 1) {
        setMarkerIndex(0);
        progressAnim.setValue(0);
      }
      startPlayback();
    }
  }, [playing, markerIndex, coords.length, progressAnim, startPlayback, stopPlayback]);

  // Restart when speed changes
  useEffect(() => {
    if (playing) {
      stopPlayback();
      startPlayback();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speed]);

  useEffect(() => () => { stopPlayback(); }, [stopPlayback]);

  // ── Share ──────────────────────────────────────────────────────────────────
  const handleShare = useCallback(() => {
    if (!drive) return;
    Share.share({
      title: 'My CONVOY Drive',
      message:
        `🏁 I drove ${formatDistance(drive.distanceM)} in ${formatDuration(drive.durationS)} on CONVOY!\n` +
        (drive.topSpeedKph ? `⚡ Top speed: ${drive.topSpeedKph.toFixed(0)} km/h\n` : '') +
        `📅 ${new Date(drive.startedAt).toLocaleDateString()}\nJoin CONVOY: convoy.app/download`,
    });
  }, [drive]);

  // ── Derived display values ─────────────────────────────────────────────────
  const elapsedS = drive
    ? Math.round((markerIndex / Math.max(coords.length - 1, 1)) * drive.durationS)
    : 0;

  const currentMarker = coords[markerIndex];
  const region = coords.length > 0 ? boundingRegion(coords) : undefined;

  // ── Render states ──────────────────────────────────────────────────────────
  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.muted}>Loading drive…</Text>
      </SafeAreaView>
    );
  }

  if (error || !drive) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.muted}>{error ?? 'Drive not found.'}</Text>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backBtnText}>← Back</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (coords.length === 0) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.emptyEmoji}>🗺️</Text>
        <Text style={styles.emptyTitle}>No GPS data available</Text>
        <Text style={styles.muted}>This drive has no recorded route trace.</Text>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backBtnText}>← Back</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => { stopPlayback(); router.back(); }} style={styles.headerBack}>
          <Text style={styles.headerBackText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.headerTitle}>
          {new Date(drive.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
        </Text>
        <Pressable onPress={handleShare} style={styles.shareBtn}>
          <Text style={styles.shareBtnText}>📤 Share</Text>
        </Pressable>
      </View>

      {/* Map */}
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={region}
        scrollEnabled
        zoomEnabled
        mapType="standard"
      >
        {/* Full route polyline in gray */}
        <Polyline coordinates={coords} strokeColor="#555555" strokeWidth={3} lineDashPattern={[6, 4]} />
        {/* Driven portion in crimson */}
        {markerIndex > 0 && (
          <Polyline
            coordinates={coords.slice(0, markerIndex + 1)}
            strokeColor="#DC143C"
            strokeWidth={3}
          />
        )}
        {/* Moving car marker */}
        {currentMarker && (
          <Marker coordinate={currentMarker} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={styles.carMarker}>
              <Text style={{ fontSize: 20 }}>🚗</Text>
            </View>
          </Marker>
        )}
        {/* Start / end pins */}
        <Marker coordinate={coords[0]} anchor={{ x: 0.5, y: 0.5 }}>
          <View style={styles.pinStart}>
            <Text style={styles.pinText}>S</Text>
          </View>
        </Marker>
        <Marker coordinate={coords[coords.length - 1]} anchor={{ x: 0.5, y: 0.5 }}>
          <View style={styles.pinEnd}>
            <Text style={styles.pinText}>F</Text>
          </View>
        </Marker>
      </MapView>

      {/* Controls */}
      <View style={styles.controls}>
        {/* Stats row */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.statsScroll} contentContainerStyle={styles.statsRow}>
          <View style={styles.statPill}>
            <Text style={styles.statValue}>{formatDistance(drive.distanceM)}</Text>
            <Text style={styles.statLabel}>distance</Text>
          </View>
          {drive.topSpeedKph != null && (
            <View style={styles.statPill}>
              <Text style={styles.statValue}>{drive.topSpeedKph.toFixed(0)} km/h</Text>
              <Text style={styles.statLabel}>top speed</Text>
            </View>
          )}
          {drive.avgSpeedKph != null && (
            <View style={styles.statPill}>
              <Text style={styles.statValue}>{drive.avgSpeedKph.toFixed(0)} km/h</Text>
              <Text style={styles.statLabel}>avg speed</Text>
            </View>
          )}
          <View style={styles.statPill}>
            <Text style={styles.statValue}>{drive.memberCount}</Text>
            <Text style={styles.statLabel}>riders</Text>
          </View>
        </ScrollView>

        {/* Duration display */}
        <View style={styles.durationRow}>
          <Text style={styles.durationText}>
            {formatDuration(elapsedS)}
            <Text style={styles.durationMuted}> / {formatDuration(drive.durationS)}</Text>
          </Text>
        </View>

        {/* Progress bar */}
        <View style={styles.progressTrack}>
          <Animated.View
            style={[
              styles.progressFill,
              {
                width: progressAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['0%', '100%'],
                }),
              },
            ]}
          />
        </View>

        {/* Play/pause + speed */}
        <View style={styles.playRow}>
          <Pressable onPress={togglePlay} style={styles.playBtn}>
            <Text style={styles.playBtnText}>{playing ? '⏸' : '▶'}</Text>
          </Pressable>
          <View style={styles.speedPills}>
            {SPEEDS.map((s) => (
              <Pressable
                key={s}
                onPress={() => setSpeed(s)}
                style={[styles.speedPill, speed === s && styles.speedPillActive]}
              >
                <Text style={[styles.speedPillText, speed === s && styles.speedPillTextActive]}>
                  {s}x
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  center: { flex: 1, backgroundColor: '#0A0A0A', alignItems: 'center', justifyContent: 'center', padding: 24 },

  // Header
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  headerBack: { paddingVertical: 4, paddingRight: 8 },
  headerBackText: { color: '#DC143C', fontSize: 17, fontWeight: '600' },
  headerTitle: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  shareBtn: { paddingVertical: 4, paddingLeft: 8 },
  shareBtnText: { color: '#DC143C', fontSize: 14 },

  // Map
  map: { flex: 1 },

  // Markers
  carMarker: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  pinStart: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#22C55E', alignItems: 'center', justifyContent: 'center' },
  pinEnd: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#DC143C', alignItems: 'center', justifyContent: 'center' },
  pinText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },

  // Controls panel
  controls: { backgroundColor: '#1C1C1C', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 20, borderTopWidth: 1, borderTopColor: '#2A2A2A' },

  statsScroll: { marginBottom: 10 },
  statsRow: { flexDirection: 'row', gap: 8 },
  statPill: { backgroundColor: '#0A0A0A', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, alignItems: 'center' },
  statValue: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  statLabel: { color: '#888888', fontSize: 11, marginTop: 1 },

  durationRow: { alignItems: 'center', marginBottom: 8 },
  durationText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  durationMuted: { color: '#888888', fontWeight: '400' },

  progressTrack: { height: 4, backgroundColor: '#2A2A2A', borderRadius: 2, overflow: 'hidden', marginBottom: 14 },
  progressFill: { height: '100%', backgroundColor: '#DC143C', borderRadius: 2 },

  playRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  playBtn: { width: 52, height: 52, borderRadius: 26, backgroundColor: '#DC143C', alignItems: 'center', justifyContent: 'center' },
  playBtnText: { fontSize: 22, color: '#FFFFFF' },
  speedPills: { flexDirection: 'row', gap: 8 },
  speedPill: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: '#2A2A2A' },
  speedPillActive: { backgroundColor: '#DC143C', borderColor: '#DC143C' },
  speedPillText: { color: '#888888', fontSize: 14, fontWeight: '600' },
  speedPillTextActive: { color: '#FFFFFF' },

  // Empty/error states
  emptyEmoji: { fontSize: 64, marginBottom: 16 },
  emptyTitle: { color: '#FFFFFF', fontSize: 20, fontWeight: '700', marginBottom: 8 },
  muted: { color: '#888888', fontSize: 15, textAlign: 'center', marginBottom: 24 },
  backBtn: { paddingVertical: 12, paddingHorizontal: 24, borderRadius: 12, borderWidth: 1, borderColor: '#DC143C' },
  backBtnText: { color: '#DC143C', fontSize: 15, fontWeight: '600' },
});
