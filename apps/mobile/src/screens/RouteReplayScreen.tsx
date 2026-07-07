import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  PanResponder,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { apiClient } from '../services/apiClient';
import { SkeletonBox } from '../components/SkeletonLoader';
import { NetworkError } from '../components/NetworkError';
import { ThemeColors, useTheme } from '../theme';

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
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [drive, setDrive] = useState<DriveDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [coords, setCoords] = useState<Coordinate[]>([]);
  const [markerIndex, setMarkerIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [sharing, setSharing] = useState(false);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressAnim = useRef(new Animated.Value(0)).current;
  const mapRef = useRef<MapView>(null);

  // ── Fetch drive ────────────────────────────────────────────────────────────
  const loadDrive = useCallback(() => {
    if (!driveId) return;
    setLoading(true);
    setError(null);
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

  useEffect(() => { loadDrive(); }, [loadDrive]);

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

  // ── Scrubbing (tap/drag the progress bar to seek) ─────────────────────────
  // Refs mirror latest state/callbacks so the PanResponder (created once) never
  // reads stale closures from the render it was constructed in.
  const trackRef = useRef<View>(null);
  const trackWidthRef = useRef(0);
  const trackPageXRef = useRef(0);
  const coordsLenRef = useRef(coords.length);
  const playingRef = useRef(playing);
  const startPlaybackRef = useRef(startPlayback);
  const wasPlayingRef = useRef(false);

  useEffect(() => { coordsLenRef.current = coords.length; }, [coords.length]);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { startPlaybackRef.current = startPlayback; }, [startPlayback]);

  const measureTrack = useCallback(() => {
    trackRef.current?.measure((_x, _y, width, _height, pageX) => {
      trackWidthRef.current = width;
      trackPageXRef.current = pageX;
    });
  }, []);

  const seekToPageX = useCallback((pageX: number) => {
    const width = trackWidthRef.current;
    const len = coordsLenRef.current;
    if (width <= 0 || len < 2) return;
    const progress = Math.min(1, Math.max(0, (pageX - trackPageXRef.current) / width));
    const index = Math.round(progress * (len - 1));
    setMarkerIndex(index);
    progressAnim.setValue(progress);
  }, [progressAnim]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        wasPlayingRef.current = playingRef.current;
        stopPlayback();
        seekToPageX(evt.nativeEvent.pageX);
      },
      onPanResponderMove: (evt) => {
        seekToPageX(evt.nativeEvent.pageX);
      },
      onPanResponderRelease: () => {
        if (wasPlayingRef.current) startPlaybackRef.current();
      },
      onPanResponderTerminate: () => {
        if (wasPlayingRef.current) startPlaybackRef.current();
      },
    }),
  ).current;

  // ── Share ──────────────────────────────────────────────────────────────────
  const handleShare = useCallback(async () => {
    if (!drive) return;
    setSharing(true);
    try {
      await Share.share({
        title: 'My CORTEGE Drive',
        message:
          `🏁 I drove ${formatDistance(drive.distanceM)} in ${formatDuration(drive.durationS)} on CORTEGE!\n` +
          (drive.topSpeedKph ? `⚡ Top speed: ${drive.topSpeedKph.toFixed(0)} km/h\n` : '') +
          `📅 ${new Date(drive.startedAt).toLocaleDateString()}\nJoin CORTEGE: convoy.app/download`,
      });
    } catch {
      Alert.alert('Error', 'Could not open share sheet');
    } finally {
      setSharing(false);
    }
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
      <SafeAreaView style={styles.skeletonContainer}>
        <SkeletonBox width="100%" height={300} borderRadius={0} />
        <View style={styles.skeletonStats}>
          <SkeletonBox width="45%" height={56} borderRadius={12} />
          <SkeletonBox width="45%" height={56} borderRadius={12} />
          <SkeletonBox width="45%" height={56} borderRadius={12} />
          <SkeletonBox width="45%" height={56} borderRadius={12} />
        </View>
      </SafeAreaView>
    );
  }

  if (error || !drive) {
    return (
      <SafeAreaView style={styles.center}>
        <NetworkError
          onRetry={error ? loadDrive : () => { router.back(); }}
          message={error ?? 'Drive not found.'}
        />
      </SafeAreaView>
    );
  }

  if (coords.length === 0) {
    return (
      <SafeAreaView style={styles.center}>
        <Ionicons name="map-outline" size={56} color={colors.textMuted} style={styles.emptyIcon} />
        <Text style={styles.emptyTitle}>No GPS data available</Text>
        <Text style={styles.muted}>This drive has no recorded route trace.</Text>
        <Pressable
          style={styles.backBtn}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={15} color={colors.accent} />
          <Text style={styles.backBtnText}> Back</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          onPress={() => { stopPlayback(); router.back(); }}
          style={styles.headerBack}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={17} color={colors.accent} />
          <Text style={styles.headerBackText}> Back</Text>
        </Pressable>
        <Text style={styles.headerTitle}>
          {new Date(drive.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
        </Text>
        <Pressable
          onPress={() => { void handleShare(); }}
          style={styles.shareBtn}
          disabled={sharing}
          accessibilityRole="button"
          accessibilityLabel="Share drive"
          accessibilityState={{ busy: sharing }}
        >
          {sharing
            ? <ActivityIndicator size="small" color={colors.accent} />
            : <Ionicons name="share-social-outline" size={15} color={colors.accent} />
          }
          <Text style={styles.shareBtnText}> {sharing ? 'Sharing…' : 'Share'}</Text>
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
        <Polyline coordinates={coords} strokeColor={colors.textSubtle} strokeWidth={3} lineDashPattern={[6, 4]} />
        {/* Driven portion in crimson */}
        {markerIndex > 0 && (
          <Polyline
            coordinates={coords.slice(0, markerIndex + 1)}
            strokeColor={colors.accent}
            strokeWidth={3}
          />
        )}
        {/* Moving car marker — fixed contrast on purpose: this floats over map
            imagery (not the app's light/dark surface), so it stays legible
            regardless of theme, matching MapScreen's marker convention. */}
        {currentMarker && (
          <Marker coordinate={currentMarker} anchor={{ x: 0.5, y: 0.5 }} title="Current replay position">
            <View style={styles.carMarker}>
              <Ionicons name="car" size={18} color="#FFFFFF" />
            </View>
          </Marker>
        )}
        {/* Start / end pins */}
        <Marker coordinate={coords[0]} anchor={{ x: 0.5, y: 0.5 }} title="Start of route">
          <View style={styles.pinStart}>
            <Text style={styles.pinText}>S</Text>
          </View>
        </Marker>
        <Marker coordinate={coords[coords.length - 1]} anchor={{ x: 0.5, y: 0.5 }} title="End of route">
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

        {/* Progress bar (tap or drag to seek) */}
        <View
          ref={trackRef}
          style={styles.progressTouchArea}
          onLayout={measureTrack}
          accessibilityRole="adjustable"
          accessibilityLabel="Seek replay position"
          accessibilityValue={{
            min: 0,
            max: 100,
            now: Math.round((markerIndex / Math.max(coords.length - 1, 1)) * 100),
          }}
          {...panResponder.panHandlers}
        >
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
        </View>

        {/* Play/pause + speed */}
        <View style={styles.playRow}>
          <Pressable
            onPress={togglePlay}
            style={styles.playBtn}
            accessibilityRole="button"
            accessibilityLabel={playing ? 'Pause' : 'Play'}
          >
            <Ionicons name={playing ? 'pause' : 'play'} size={22} color="#FFFFFF" />
          </Pressable>
          <View style={styles.speedPills}>
            {SPEEDS.map((s) => (
              <Pressable
                key={s}
                onPress={() => setSpeed(s)}
                style={[styles.speedPill, speed === s && styles.speedPillActive]}
                accessibilityRole="button"
                accessibilityLabel={`${s}x speed`}
                accessibilityState={{ selected: speed === s }}
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

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 24 },
    skeletonContainer: { flex: 1, backgroundColor: colors.bg },
    skeletonStats: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, padding: 16, justifyContent: 'space-between' },

    // Header
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
    headerBack: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, paddingRight: 8 },
    headerBackText: { color: colors.accent, fontSize: 17, fontWeight: '600' },
    headerTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
    shareBtn: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, paddingLeft: 8 },
    shareBtnText: { color: colors.accent, fontSize: 14 },

    // Map
    map: { flex: 1 },

    // Markers — fixed contrast on purpose: these float over map imagery
    // (not the app's light/dark surface), so they stay legible regardless
    // of theme, matching MapScreen's marker convention.
    carMarker: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
    pinStart: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.success, alignItems: 'center', justifyContent: 'center' },
    pinEnd: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
    pinText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },

    // Controls panel
    controls: { backgroundColor: colors.card, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 20, borderTopWidth: 1, borderTopColor: colors.border },

    statsScroll: { marginBottom: 10 },
    statsRow: { flexDirection: 'row', gap: 8 },
    statPill: { backgroundColor: colors.bg, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, alignItems: 'center' },
    statValue: { color: colors.text, fontSize: 14, fontWeight: '700' },
    statLabel: { color: colors.textMuted, fontSize: 11, marginTop: 1 },

    durationRow: { alignItems: 'center', marginBottom: 8 },
    durationText: { color: colors.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
    durationMuted: { color: colors.textMuted, fontWeight: '400' },

    progressTouchArea: { minHeight: 44, justifyContent: 'center', marginBottom: 4 },
    progressTrack: { height: 4, backgroundColor: colors.border, borderRadius: 2, overflow: 'hidden' },
    progressFill: { height: '100%', backgroundColor: colors.accent, borderRadius: 2 },

    playRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    playBtn: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
    speedPills: { flexDirection: 'row', gap: 8 },
    speedPill: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: colors.border },
    speedPillActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    speedPillText: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },
    speedPillTextActive: { color: '#FFFFFF' },

    // Empty/error states
    emptyIcon: { marginBottom: 16 },
    emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '700', marginBottom: 8 },
    muted: { color: colors.textMuted, fontSize: 15, textAlign: 'center', marginBottom: 24 },
    backBtn: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 12, borderWidth: 1, borderColor: colors.accent },
    backBtnText: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  });
}
