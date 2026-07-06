import React, { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Dimensions,
  Image,
  Linking,
  Modal,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { captureRef } from 'react-native-view-shot';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme, ThemeColors } from '../theme';

// ---------------------------------------------------------------------------
// Confetti burst — 24 particles, pure RN Animated, no third-party lib
// ---------------------------------------------------------------------------

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const PARTICLE_COUNT = 24;

// Dimensions-only (no color) so the module-level Confetti component doesn't
// need the themed `styles` sheet — color is applied per-particle inline.
const particleBaseStyle = {
  position: 'absolute',
  top: 0,
  width: 8,
  height: 8,
  borderRadius: 2,
} as const;

interface Particle {
  x: number;
  color: string;
  translateY: Animated.Value;
  translateX: Animated.Value;
  opacity: Animated.Value;
  rotate: Animated.Value;
}

function useConfetti(colors: ThemeColors): Particle[] {
  return useMemo(() => {
    const confettiColors = [colors.accent, colors.text, colors.warning, colors.success, colors.info, '#A78BFA'];
    return Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
      x: (SCREEN_W / PARTICLE_COUNT) * i + Math.random() * 30 - 15,
      color: confettiColors[i % confettiColors.length],
      translateY: new Animated.Value(-20),
      translateX: new Animated.Value(0),
      opacity: new Animated.Value(1),
      rotate: new Animated.Value(0),
    }));
  }, [colors]);
}

function Confetti() {
  const { colors } = useTheme();
  const particles = useConfetti(colors);

  useEffect(() => {
    const anims = particles.map((p, i) =>
      Animated.parallel([
        Animated.timing(p.translateY, {
          toValue: SCREEN_H * 0.75,
          duration: 2000 + Math.random() * 1000,
          delay: i * 60,
          useNativeDriver: true,
        }),
        Animated.timing(p.translateX, {
          toValue: (Math.random() - 0.5) * 100,
          duration: 2000 + Math.random() * 1000,
          delay: i * 60,
          useNativeDriver: true,
        }),
        Animated.timing(p.opacity, {
          toValue: 0,
          duration: 600,
          delay: i * 60 + 1400,
          useNativeDriver: true,
        }),
        Animated.timing(p.rotate, {
          toValue: 4 + Math.random() * 4,
          duration: 2000 + Math.random() * 1000,
          delay: i * 60,
          useNativeDriver: true,
        }),
      ]),
    );
    Animated.stagger(40, anims).start();
  }, [particles]);

  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
      {particles.map((p, i) => {
        const spin = p.rotate.interpolate({ inputRange: [0, 8], outputRange: ['0deg', '720deg'] });
        return (
          <Animated.View
            key={i}
            style={[
              particleBaseStyle,
              {
                left: p.x,
                backgroundColor: p.color,
                opacity: p.opacity,
                transform: [
                  { translateY: p.translateY },
                  { translateX: p.translateX },
                  { rotate: spin },
                ],
              },
            ]}
          />
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatDistance(metres: number): string {
  if (metres < 1000) return `${metres} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

function buildShareText(
  distanceKm: string,
  duration: string,
  members: number,
  topSpeed: number | null,
  groupName: string,
): string {
  const lines: string[] = [
    `🏁 Just finished a convoy with ${groupName} on CORTEGE!`,
    `📍 ${distanceKm} in ${duration}`,
    `👥 ${members} car${members !== 1 ? 's' : ''} strong`,
  ];
  if (topSpeed != null) {
    lines.push(`🏎️ Top speed: ${topSpeed} km/h`);
  }
  lines.push('');
  lines.push('Join us at convoy.app');
  return lines.join('\n');
}

interface LatLng {
  latitude: number;
  longitude: number;
}

// routeTrace arrives as a JSON string — either a GeoJSON LineString
// (`{ type, coordinates: [lng, lat][] }`, matching the format used elsewhere
// in the app e.g. RouteReplayScreen/DriveHistoryScreen) or a bare
// `[lng, lat][]` coordinate array. Anything else is treated as "no trace".
function parseRouteCoords(routeTrace?: string): LatLng[] {
  if (!routeTrace) return [];
  try {
    const parsed: unknown = JSON.parse(routeTrace);
    const coords = Array.isArray(parsed)
      ? parsed
      : (parsed as { coordinates?: unknown })?.coordinates;
    if (!Array.isArray(coords)) return [];
    return coords
      .filter(
        (c: unknown): c is [number, number] =>
          Array.isArray(c) && c.length === 2 && typeof c[0] === 'number' && typeof c[1] === 'number',
      )
      .map(([lng, lat]: [number, number]) => ({ latitude: lat, longitude: lng }));
  } catch {
    return [];
  }
}

function getWeekKey(): string {
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${week}`;
}

async function incrementWeeklyDrives(): Promise<number> {
  try {
    const key = `convoy_weekly_drives_${getWeekKey()}`;
    const raw = await AsyncStorage.getItem(key);
    const count = (parseInt(raw ?? '0', 10) || 0) + 1;
    await AsyncStorage.setItem(key, String(count));
    return count;
  } catch {
    return 1;
  }
}

// ---------------------------------------------------------------------------
// ShareCard — visual preview card for the share sheet
// ---------------------------------------------------------------------------

interface ShareCardProps {
  groupName: string;
  distanceText: string;
  duration: string;
  members: number;
  topSpeed: number | null;
}

function ShareCard({ groupName, distanceText, duration, members, topSpeed }: ShareCardProps) {
  const { colors } = useTheme();
  const shareCardStyles = useMemo(() => createShareCardStyles(colors), [colors]);
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return (
    <View style={shareCardStyles.card}>
      <View style={shareCardStyles.header}>
        <Text style={shareCardStyles.wordmark}>CORTEGE</Text>
        <Text style={shareCardStyles.flag}>🏁</Text>
      </View>
      <Text style={shareCardStyles.groupName}>{groupName}</Text>
      <Text style={shareCardStyles.date}>{dateStr}</Text>
      <View style={shareCardStyles.divider} />
      <Text style={shareCardStyles.statsLine}>
        {distanceText} · {duration} · {members} {members === 1 ? 'car' : 'cars'}
      </Text>
      {topSpeed != null && (
        <Text style={shareCardStyles.speedLine}>Max speed: {topSpeed} km/h</Text>
      )}
      <View style={shareCardStyles.routeLine}>
        <View style={shareCardStyles.dot} />
        <View style={shareCardStyles.line} />
        <View style={shareCardStyles.flag2} />
      </View>
      <Text style={shareCardStyles.url}>convoy.app</Text>
    </View>
  );
}

function createShareCardStyles(colors: ThemeColors) {
  return StyleSheet.create({
  card: {
    backgroundColor: '#111111',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.accent,
    padding: 20,
    width: '100%',
    marginBottom: 16,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  wordmark: {
    color: colors.accent,
    fontWeight: '900',
    fontSize: 18,
    letterSpacing: 3,
  },
  flag: { fontSize: 22 },
  groupName: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 2,
  },
  date: {
    color: colors.textMuted,
    fontSize: 12,
    marginBottom: 12,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginBottom: 12,
  },
  statsLine: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
  },
  speedLine: {
    color: colors.textMuted,
    fontSize: 12,
    marginBottom: 12,
  },
  routeLine: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 12,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.success,
  },
  line: {
    flex: 1,
    height: 2,
    backgroundColor: colors.accent,
    marginHorizontal: 6,
  },
  flag2: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  url: {
    color: colors.textMuted,
    fontSize: 11,
    textAlign: 'right',
    letterSpacing: 0.5,
  },
  });
}

// ---------------------------------------------------------------------------
// DriveSummaryCard — offscreen composite captured to an image for
// sharing / saving (Req 19.5, 19.6). Combines a stylized route trace, key
// drive stats, and CONVOY/CORTEGE branding.
//
// The route trace is drawn with plain rotated Views rather than an embedded
// native MapView: react-native-view-shot cannot reliably capture native map
// SurfaceViews (especially on Android), so a lightweight vector rendering of
// the polyline is used instead — it's a deliberate simplification, not a
// stand-in for a full map render.
// ---------------------------------------------------------------------------

const SUMMARY_CARD_WIDTH = 360;
const MINIMAP_WIDTH = SUMMARY_CARD_WIDTH - 48; // minus horizontal padding
const MINIMAP_HEIGHT = 150;
const MINIMAP_PADDING = 14;

function projectRouteCoords(
  coords: LatLng[],
  width: number,
  height: number,
  padding: number,
): { x: number; y: number }[] {
  if (coords.length === 0) return [];
  const lats = coords.map((c) => c.latitude);
  const lngs = coords.map((c) => c.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latRange = Math.max(maxLat - minLat, 0.0001);
  const lngRange = Math.max(maxLng - minLng, 0.0001);
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const scale = Math.min(innerW / lngRange, innerH / latRange);
  const usedW = lngRange * scale;
  const usedH = latRange * scale;
  const offsetX = padding + (innerW - usedW) / 2;
  const offsetY = padding + (innerH - usedH) / 2;
  return coords.map((c) => ({
    x: offsetX + (c.longitude - minLng) * scale,
    // Flip Y — latitude increases upward, screen coordinates increase downward.
    y: offsetY + (maxLat - c.latitude) * scale,
  }));
}

// Rotates a thin line View around its start point (x1, y1) without relying on
// the `transformOrigin` style prop: a zero-size outer View is positioned at
// the pivot and rotated, so its "center" (used as the default transform
// origin) coincides with the pivot point.
function RouteSegment({ x1, y1, x2, y2, color }: { x1: number; y1: number; x2: number; y2: number; color: string }) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return (
    <View
      style={{
        position: 'absolute',
        left: x1,
        top: y1,
        width: 0,
        height: 0,
        transform: [{ rotate: `${angleDeg}deg` }],
      }}
    >
      <View
        style={{
          position: 'absolute',
          left: 0,
          top: -1.5,
          width: length,
          height: 3,
          borderRadius: 1.5,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

function RouteMiniMap({ coords }: { coords: LatLng[] }) {
  const points = useMemo(
    () => projectRouteCoords(coords, MINIMAP_WIDTH, MINIMAP_HEIGHT, MINIMAP_PADDING),
    [coords],
  );

  if (points.length < 2) {
    // Fallback: same minimal "dot — line — flag" motif used when a real
    // trace isn't available, rather than a blank box.
    return (
      <View style={[miniMapStyles.box, miniMapStyles.boxEmpty]}>
        <View style={miniMapStyles.fallbackDot} />
        <View style={miniMapStyles.fallbackLine} />
        <View style={miniMapStyles.fallbackFlag} />
      </View>
    );
  }

  const start = points[0];
  const end = points[points.length - 1];

  return (
    <View style={miniMapStyles.box}>
      {points.slice(1).map((p, i) => (
        <RouteSegment key={i} x1={points[i].x} y1={points[i].y} x2={p.x} y2={p.y} color={T.accent} />
      ))}
      <View style={[miniMapStyles.pin, miniMapStyles.pinStart, { left: start.x - 5, top: start.y - 5 }]} />
      <View style={[miniMapStyles.pin, miniMapStyles.pinEnd, { left: end.x - 5, top: end.y - 5 }]} />
    </View>
  );
}

const miniMapStyles = StyleSheet.create({
  box: {
    width: MINIMAP_WIDTH,
    height: MINIMAP_HEIGHT,
    backgroundColor: '#161616',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    overflow: 'hidden',
    marginBottom: 14,
  },
  boxEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  fallbackDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: T.success },
  fallbackLine: { flex: 1, maxWidth: 140, height: 2, backgroundColor: T.accent, marginHorizontal: 8 },
  fallbackFlag: { width: 10, height: 10, borderRadius: 5, backgroundColor: T.accent },
  pin: { position: 'absolute', width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: '#111111' },
  pinStart: { backgroundColor: T.success },
  pinEnd: { backgroundColor: T.accent },
});

interface DriveSummaryCardProps {
  groupName: string;
  distanceText: string;
  duration: string;
  avgSpeedText: string | null;
  topSpeed: number | null;
  members: number;
  routeCoords: LatLng[];
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={miniStatStyles.item}>
      <Text style={miniStatStyles.value} numberOfLines={1}>{value}</Text>
      <Text style={miniStatStyles.label}>{label}</Text>
    </View>
  );
}

const miniStatStyles = StyleSheet.create({
  item: { width: '33%', marginBottom: 10 },
  value: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  label: { color: '#888888', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 1 },
});

const DriveSummaryCard = forwardRef<View, DriveSummaryCardProps>(function DriveSummaryCard(
  { groupName, distanceText, duration, avgSpeedText, topSpeed, members, routeCoords },
  ref,
) {
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return (
    <View ref={ref} collapsable={false} style={summaryCardStyles.root}>
      <View style={summaryCardStyles.header}>
        <Text style={summaryCardStyles.wordmark}>CORTEGE</Text>
        <Text style={summaryCardStyles.flag}>🏁</Text>
      </View>
      <Text style={summaryCardStyles.groupName} numberOfLines={1}>{groupName}</Text>
      <Text style={summaryCardStyles.date}>{dateStr}</Text>

      <RouteMiniMap coords={routeCoords} />

      <View style={summaryCardStyles.statsGrid}>
        <MiniStat label="Distance" value={distanceText} />
        <MiniStat label="Duration" value={duration} />
        <MiniStat label="Crew" value={`${members} ${members === 1 ? 'car' : 'cars'}`} />
        {avgSpeedText != null && <MiniStat label="Avg Speed" value={avgSpeedText} />}
        {topSpeed != null && <MiniStat label="Top Speed" value={`${topSpeed} km/h`} />}
      </View>

      <Text style={summaryCardStyles.url}>convoy.app</Text>
    </View>
  );
});

const summaryCardStyles = StyleSheet.create({
  root: {
    // Rendered off-screen (see offscreenCapture wrapper below) purely so
    // react-native-view-shot has a real, laid-out native view to snapshot.
    width: SUMMARY_CARD_WIDTH,
    backgroundColor: '#111111',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#DC143C',
    padding: 24,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  wordmark: { color: '#DC143C', fontWeight: '900', fontSize: 20, letterSpacing: 3 },
  flag: { fontSize: 24 },
  groupName: { color: '#FFFFFF', fontSize: 22, fontWeight: '700', marginBottom: 2 },
  date: { color: '#888888', fontSize: 12, marginBottom: 16 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  url: { color: '#888888', fontSize: 11, textAlign: 'right', letterSpacing: 0.5, marginTop: 2 },
});

// ---------------------------------------------------------------------------
// StatCard — one of three horizontal cards
// ---------------------------------------------------------------------------

interface StatCardProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
}

function StatCard({ icon, label, value }: StatCardProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.statCard}>
      <Ionicons name={icon} size={20} color={colors.textMuted} style={styles.statEmoji} />
      <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Route Summary card — placeholder if no real trace data
// ---------------------------------------------------------------------------

function RouteSummaryCard({ hasTrace }: { hasTrace: boolean }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.routeCard}>
      {hasTrace ? (
        <View style={styles.routeTracePlaceholder}>
          <View style={styles.routeLineLeft} />
          <View style={styles.routeDot} />
          <View style={styles.routeLineRight} />
        </View>
      ) : (
        <Ionicons name="map-outline" size={32} color={colors.textMuted} style={styles.routeNoTraceIcon} />
      )}
      <Text style={styles.routeLabel}>Route Summary</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function ConvoyEndScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const achievementStyles = useMemo(() => createAchievementStyles(colors), [colors]);
  const extraStyles = useMemo(() => createExtraStyles(colors), [colors]);
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const {
    groupName,
    durationMinutes,
    distanceM,
    memberCount,
    topSpeedKmh,
    avgSpeedKmh: avgSpeedKmhParam,
    routeTrace,
  } = useLocalSearchParams<{
    groupName: string;
    durationMinutes: string;
    distanceM: string;
    memberCount: string;
    topSpeedKmh?: string;
    avgSpeedKmh?: string;
    routeTrace?: string;
  }>();

  // Ref to the offscreen DriveSummaryCard, captured to an image on demand.
  const summaryCardRef = useRef<View>(null);

  // Trophy spring: scale 0 → 1
  const scale = useRef(new Animated.Value(0)).current;
  const iconOpacity = useRef(new Animated.Value(0)).current;
  const contentOpacity = useRef(new Animated.Value(0)).current;

  // Stable drive ID for photo storage
  const driveId = useRef(`drive_${Date.now()}`).current;

  // State
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);
  const [weeklyDrives, setWeeklyDrives] = useState(0);
  const [photos, setPhotos] = useState<string[]>([]);
  const [previewPhoto, setPreviewPhoto] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    incrementWeeklyDrives().then(setWeeklyDrives);
  }, []);

  // App Store review prompt — shown after 3rd completed convoy
  useEffect(() => {
    async function maybeAskForReview() {
      try {
        const raw = await AsyncStorage.getItem('convoy:completed_count');
        const count = (parseInt(raw ?? '0', 10) || 0) + 1;
        await AsyncStorage.setItem('convoy:completed_count', String(count));
        const hasReviewed = await AsyncStorage.getItem('convoy:has_reviewed');
        if (count === 3 && !hasReviewed) {
          setTimeout(() => {
            Alert.alert(
              '❤️ Loving CORTEGE?',
              'A quick rating helps us grow the community of drivers.',
              [
                {
                  text: '⭐ Rate 5 Stars',
                  onPress: async () => {
                    await AsyncStorage.setItem('convoy:has_reviewed', 'true');
                    // Opens App Store page — replace with real app ID before launch
                    Linking.openURL('https://apps.apple.com/app/id000000000');
                  },
                },
                { text: 'Maybe Later', style: 'cancel' },
              ],
            );
          }, 3000);
        }
      } catch {
        // intentionally empty — review prompt is best-effort only
      }
    }
    maybeAskForReview();
  }, []);

  // First-convoy achievement unlock
  const [showFirstConvoyAchievement, setShowFirstConvoyAchievement] = useState(false);
  const achievementScale = useRef(new Animated.Value(0)).current;
  const achievementOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    async function checkFirstConvoy() {
      try {
        const raw = await AsyncStorage.getItem('convoy:completed_count');
        const convoyCount = parseInt(raw ?? '0', 10) || 0;
        // convoyCount was already incremented in maybeAskForReview; treat convoyCount===1 as first
        if (convoyCount === 1) {
          const alreadyGranted = await AsyncStorage.getItem('achievement:first_convoy');
          if (!alreadyGranted) {
            await AsyncStorage.setItem('achievement:first_convoy', 'true');
            setTimeout(() => {
              setShowFirstConvoyAchievement(true);
              Animated.spring(achievementScale, {
                toValue: 1,
                useNativeDriver: true,
                tension: 140,
                friction: 7,
              }).start();
              Animated.timing(achievementOpacity, {
                toValue: 1,
                duration: 200,
                useNativeDriver: true,
              }).start();
            }, 1800);
          }
        }
      } catch {
        // intentionally empty — achievement unlock check is best-effort only
      }
    }
    checkFirstConvoy();
  }, []);

  const dismissFirstConvoyAchievement = () => {
    Animated.parallel([
      Animated.timing(achievementScale, { toValue: 0.8, duration: 150, useNativeDriver: true }),
      Animated.timing(achievementOpacity, { toValue: 0, duration: 150, useNativeDriver: true }),
    ]).start(() => {
      setShowFirstConvoyAchievement(false);
      achievementScale.setValue(0);
      achievementOpacity.setValue(0);
    });
  };

  // Load persisted photos for this drive
  useEffect(() => {
    AsyncStorage.getItem(`convoy:drive:${driveId}:photos`)
      .then(raw => { if (raw) setPhotos(JSON.parse(raw)); })
      .catch(() => {});
  }, [driveId]);

  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, {
        toValue: 1,
        useNativeDriver: true,
        tension: 160,
        friction: 7,
      }),
      Animated.timing(iconOpacity, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start();

    Animated.timing(contentOpacity, {
      toValue: 1,
      duration: 480,
      delay: 280,
      useNativeDriver: true,
    }).start();
  }, []);

  // Clean up copy timer on unmount
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const duration = parseInt(durationMinutes ?? '0', 10);
  const distance = parseInt(distanceM ?? '0', 10);
  const members = parseInt(memberCount ?? '1', 10);
  const topSpeed = topSpeedKmh ? parseInt(topSpeedKmh, 10) : null;
  const hasTrace = Boolean(routeTrace && routeTrace.length > 0);
  const displayGroup = groupName ?? 'Your Crew';

  // Human-readable distance for the share card (always km if >= 1 km)
  const distanceKmText =
    distance >= 1000 ? `${(distance / 1000).toFixed(1)}km` : `${distance}m`;

  // Average speed: prefer a value passed in from the caller; otherwise derive
  // it from distance/duration so the summary card always has something to show.
  const avgSpeedKmh = avgSpeedKmhParam
    ? parseFloat(avgSpeedKmhParam)
    : duration > 0
      ? (distance / 1000) / (duration / 60)
      : null;
  const avgSpeedText = avgSpeedKmh != null && Number.isFinite(avgSpeedKmh) ? `${avgSpeedKmh.toFixed(0)} km/h` : null;

  const routeCoords = useMemo(() => parseRouteCoords(routeTrace), [routeTrace]);

  const shareText = buildShareText(distanceKmText, formatDuration(duration), members, topSpeed, displayGroup)
    + (photos.length > 0 ? `\n📸 ${photos.length} photo${photos.length !== 1 ? 's' : ''} from the drive` : '');

  const savePhotos = async (newPhotos: string[]) => {
    try {
      await AsyncStorage.setItem(`convoy:drive:${driveId}:photos`, JSON.stringify(newPhotos));
    } catch {
      // intentionally empty — persisting drive photos locally is best-effort only
    }
  };

  const pickFromLibrary = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Please allow access to your photo library to add drive photos.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
      allowsEditing: false,
    });
    if (result.canceled) return;
    const uri = result.assets[0].uri;
    const newPhotos = [...photos, uri];
    setPhotos(newPhotos);
    await savePhotos(newPhotos);
  };

  // Captures the offscreen DriveSummaryCard (route trace + stats + branding)
  // as a PNG file. Returns null if capture fails for any reason (e.g. the
  // view hasn't laid out yet) — callers fall back to a text-only share.
  const captureSummaryCard = async (): Promise<string | null> => {
    try {
      const uri = await captureRef(summaryCardRef, { format: 'png', quality: 1 });
      return uri;
    } catch {
      return null;
    }
  };

  const handleShare = async () => {
    const cardUri = await captureSummaryCard();

    if (cardUri) {
      try {
        if (Platform.OS === 'ios') {
          // iOS's native Share sheet can combine a local file URL with a
          // text message in one activity.
          await Share.share({ title: 'My CORTEGE drive', message: shareText, url: cardUri });
        } else if (await Sharing.isAvailableAsync()) {
          // Android's Share module doesn't support local file attachments via
          // `url` — expo-sharing drives the native share sheet with the image
          // attached instead (Req 19.6).
          await Sharing.shareAsync(cardUri, {
            mimeType: 'image/png',
            dialogTitle: 'Share your CORTEGE drive summary',
          });
        } else {
          await Share.share({ title: 'My CORTEGE drive', message: shareText });
        }
        setShared(true);
        return;
      } catch {
        // User cancelled, or the share sheet failed — fall through to the
        // plain-text share below rather than leaving the user stuck.
      }
    }

    try {
      await Share.share({
        title: 'My CORTEGE drive',
        message: shareText,
      });
      setShared(true);
    } catch {
      // User cancelled — swallow silently
    }
  };

  const handleSaveToPhotos = async () => {
    const { status } = await MediaLibrary.requestPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Please allow photo library access to save photos.');
      return;
    }

    // Always try to save the generated summary card (Req 19.6), in addition
    // to any photos the user manually attached during the drive.
    let savedCard = false;
    const cardUri = await captureSummaryCard();
    if (cardUri) {
      try {
        await MediaLibrary.saveToLibraryAsync(cardUri);
        savedCard = true;
      } catch { /* fall through — still try the manually-added photos */ }
    }

    let savedPhotos = 0;
    for (const uri of photos) {
      try {
        await MediaLibrary.saveToLibraryAsync(uri);
        savedPhotos++;
      } catch { /* skip photos that fail */ }
    }

    if (!savedCard && savedPhotos === 0) {
      Alert.alert('Nothing to Save', 'Could not generate the summary card. Please try again.');
      return;
    }

    const parts: string[] = [];
    if (savedCard) parts.push('Summary card');
    if (savedPhotos > 0) parts.push(`${savedPhotos} drive photo${savedPhotos !== 1 ? 's' : ''}`);
    Alert.alert('Saved', `${parts.join(' and ')} saved to your camera roll.`);
  };

  const handleCopy = async () => {
    await Clipboard.setStringAsync(shareText);
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Confetti />

      {/*
        Offscreen shareable summary card (Req 19.5/19.6) — rendered off the
        visible canvas but still fully laid out so captureRef can snapshot it
        on demand from handleShare/handleSaveToPhotos. `collapsable={false}`
        keeps Android from flattening the view out of the native tree.
      */}
      <View style={styles.offscreenCapture} pointerEvents="none">
        <DriveSummaryCard
          ref={summaryCardRef}
          groupName={displayGroup}
          distanceText={distanceKmText}
          duration={formatDuration(duration)}
          avgSpeedText={avgSpeedText}
          topSpeed={topSpeed}
          members={members}
          routeCoords={routeCoords}
        />
      </View>

      {/* First-convoy achievement unlock modal */}
      {showFirstConvoyAchievement && (
        <Modal visible transparent animationType="none" onRequestClose={dismissFirstConvoyAchievement}>
          <TouchableOpacity
            style={achievementStyles.backdrop}
            activeOpacity={1}
            onPress={dismissFirstConvoyAchievement}
          >
            <Animated.View
              style={[
                achievementStyles.card,
                { transform: [{ scale: achievementScale }], opacity: achievementOpacity },
              ]}
            >
              <MaterialCommunityIcons name="flag-checkered" size={64} color={colors.accent} style={achievementStyles.badge} />
              <Text style={achievementStyles.unlockLabel}>Achievement Unlocked!</Text>
              <Text style={achievementStyles.achievementName}>First Convoy</Text>
              <Text style={achievementStyles.achievementDesc}>You completed your very first convoy. The journey begins!</Text>
              <TouchableOpacity
                style={achievementStyles.doneBtn}
                onPress={dismissFirstConvoyAchievement}
                accessibilityRole="button"
                accessibilityLabel="Dismiss achievement"
              >
                <Text style={achievementStyles.doneBtnText}>Awesome!</Text>
              </TouchableOpacity>
            </Animated.View>
          </TouchableOpacity>
        </Modal>
      )}

      {/* Full-screen photo preview modal */}
      <Modal visible={previewPhoto !== null} transparent animationType="fade" onRequestClose={() => setPreviewPhoto(null)}>
        <View style={styles.photoModalBg}>
          <TouchableOpacity
            style={styles.photoModalClose}
            onPress={() => setPreviewPhoto(null)}
            accessibilityRole="button"
            accessibilityLabel="Close photo preview"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="close" size={18} color={colors.text} />
          </TouchableOpacity>
          {previewPhoto && (
            <Image source={{ uri: previewPhoto }} style={styles.photoModalImage} resizeMode="contain" />
          )}
        </View>
      </Modal>

      {/* Body */}
      <View style={styles.inner}>
        {/* Trophy — Animated.spring scale 0 → 1 */}
        <Animated.View
          style={[
            styles.trophyEmoji,
            { transform: [{ scale }], opacity: iconOpacity },
          ]}
        >
          <Ionicons name="trophy" size={80} color={colors.warning} />
        </Animated.View>

        <Animated.View style={[styles.contentBlock, { opacity: contentOpacity }]}>
          <Text style={styles.title}>Convoy Complete</Text>
          <Text style={styles.subtitle}>
            Great drive with{' '}
            <Text style={styles.groupName}>{displayGroup}</Text>
          </Text>

          {/* 3-stat row: Duration · Distance · Members */}
          <View style={styles.statsRow}>
            <StatCard icon="time-outline" label="Duration" value={formatDuration(duration)} />
            <StatCard icon="location-outline" label="Distance" value={formatDistance(distance)} />
            <StatCard icon="people-outline" label="Members" value={`${members}`} />
          </View>

          {/* Route minimap / placeholder */}
          <RouteSummaryCard hasTrace={hasTrace} />
        </Animated.View>
      </View>

      {/* Anchored footer */}
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        {/* Weekly streak banner */}
        {weeklyDrives >= 3 && (
          <View style={extraStyles.streakBanner}>
            <Text style={extraStyles.streakText}>
              🔥 {weeklyDrives}-drive week! You're on a streak!
            </Text>
          </View>
        )}

        {/* Drive Photos section */}
        <View style={styles.photoSection}>
          <View style={styles.photoSectionHeader}>
            <Text style={styles.photoSectionTitle}>
              <Ionicons name="images-outline" size={14} color={colors.text} /> Drive Photos
            </Text>
            <TouchableOpacity onPress={pickFromLibrary} accessibilityLabel="Add drive photos">
              <Text style={styles.photoAddBtn}>+ Add</Text>
            </TouchableOpacity>
          </View>
          {photos.length === 0 ? (
            <TouchableOpacity style={styles.photoEmptyState} onPress={pickFromLibrary}>
              <Ionicons name="camera-outline" size={24} color={colors.textMuted} style={styles.photoEmptyIcon} />
              <Text style={styles.photoEmptyText}>Add photos from today's drive</Text>
            </TouchableOpacity>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.photoScroll}>
              {photos.map((uri, idx) => (
                <TouchableOpacity
                  key={idx}
                  onPress={() => setPreviewPhoto(uri)}
                  accessibilityRole="button"
                  accessibilityLabel={`View photo ${idx + 1} of ${photos.length}`}
                >
                  <Image source={{ uri }} style={styles.photoThumb} resizeMode="cover" />
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                style={styles.photoAddThumb}
                onPress={pickFromLibrary}
                accessibilityRole="button"
                accessibilityLabel="Add photo"
              >
                <Text style={styles.photoAddThumbIcon}>+</Text>
              </TouchableOpacity>
            </ScrollView>
          )}
        </View>

        {/* Visual share card */}
        <ShareCard
          groupName={displayGroup}
          distanceText={distanceKmText}
          duration={formatDuration(duration)}
          members={members}
          topSpeed={topSpeed}
        />

        {/* Share Your Ride — full-width crimson share button */}
        <TouchableOpacity
          style={styles.shareBtn}
          onPress={handleShare}
          accessibilityRole="button"
          accessibilityLabel="Share your ride summary"
        >
          <Text style={styles.shareBtnText}>Share Your Ride 🚀</Text>
        </TouchableOpacity>

        {/* Save to Photos + Copy row */}
        <View style={extraStyles.secondaryRow}>
          <TouchableOpacity
            style={extraStyles.secondaryBtn}
            onPress={handleSaveToPhotos}
            accessibilityRole="button"
            accessibilityLabel="Save to Photos"
          >
            <Text style={extraStyles.secondaryBtnText}>
              <Ionicons name="camera-outline" size={13} color={colors.textMuted} /> Save
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={extraStyles.secondaryBtn}
            onPress={handleCopy}
            accessibilityRole="button"
            accessibilityLabel={copied ? 'Copied to clipboard' : 'Copy stats to clipboard'}
          >
            <Text style={extraStyles.secondaryBtnText}>
              {copied
                ? <><Ionicons name="checkmark" size={13} color={colors.textMuted} /> Copied!</>
                : <><Ionicons name="clipboard-outline" size={13} color={colors.textMuted} /> Copy text</>}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Post-share social prompt */}
        {shared && (
          <View style={extraStyles.socialPrompt}>
            <Text style={extraStyles.socialPromptText}>
              Tell your crew about CORTEGE — invite them to your next drive!
            </Text>
            <TouchableOpacity
              style={extraStyles.inviteBtn}
              onPress={async () => {
                await Clipboard.setStringAsync('https://convoy.app/download');
                Alert.alert('Link Copied!', 'Share convoy.app/download with your friends.');
              }}
            >
              <Text style={extraStyles.inviteBtnText}>Copy Invite Link</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Drive Again — crimson primary */}
        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={() => router.replace('/(tabs)/map')}
          accessibilityRole="button"
          accessibilityLabel={`Drive Again with ${displayGroup}`}
        >
          <Text style={styles.primaryBtnText} numberOfLines={1} adjustsFontSizeToFit>
            Drive Again with {displayGroup}
          </Text>
        </TouchableOpacity>

        {/* Back to Home — ghost */}
        <TouchableOpacity
          style={styles.ghostBtn}
          onPress={() => router.replace('/(tabs)/map')}
          accessibilityRole="button"
          accessibilityLabel="Back to Home"
        >
          <Text style={styles.ghostBtnText}>Back to Home</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },

  // Positions the DriveSummaryCard well off the visible canvas while still
  // laying it out normally, so react-native-view-shot can capture it.
  offscreenCapture: {
    position: 'absolute',
    top: 0,
    left: -(SUMMARY_CARD_WIDTH + 100),
  },

  inner: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  contentBlock: {
    alignItems: 'center',
    width: '100%',
  },

  // Trophy icon
  trophyEmoji: {
    marginBottom: 20,
    alignItems: 'center',
  },

  // Headline
  title: {
    fontSize: 30,
    fontWeight: '800',
    color: colors.text,
    textAlign: 'center',
    marginBottom: 6,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 15,
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: 28,
  },
  groupName: {
    color: colors.accent,
    fontWeight: '700',
  },

  // Stat row — three equal-width cards side by side
  statsRow: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
    marginBottom: 20,
  },
  statCard: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 6,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  statEmoji: {
    fontSize: 20,
    marginBottom: 6,
  },
  statValue: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 3,
    textAlign: 'center',
  },
  statLabel: {
    fontSize: 10,
    color: colors.textMuted,
    textAlign: 'center',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },

  // Route summary card
  routeCard: {
    width: '100%',
    backgroundColor: colors.cardElevated,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 20,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  routeTracePlaceholder: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    width: '80%',
  },
  routeLineLeft: {
    flex: 1,
    height: 2,
    backgroundColor: colors.accent,
    borderRadius: 1,
  },
  routeDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.success,
    marginHorizontal: 4,
  },
  routeLineRight: {
    flex: 1,
    height: 2,
    backgroundColor: colors.textMuted,
    borderRadius: 1,
    opacity: 0.5,
  },
  routeNoTraceIcon: {
    fontSize: 32,
    marginBottom: 10,
  },
  routeLabel: {
    fontSize: 11,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontWeight: '600',
  },

  // Footer buttons
  footer: {
    paddingHorizontal: 24,
    gap: 12,
  },

  // Share Your Ride — full-width crimson, 52px height, 14px radius
  shareBtn: {
    backgroundColor: colors.accent,
    borderRadius: 14,
    height: 52,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareBtnText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.2,
  },

  // Copy text — small muted link below share button (kept for backwards compat)
  copyLink: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 2,
    marginTop: -4,
  },
  copyLinkText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '500',
  },

  primaryBtn: {
    backgroundColor: colors.accent,
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
  },
  primaryBtnText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  ghostBtn: {
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 52,
  },
  ghostBtnText: {
    color: colors.textMuted,
    fontSize: 15,
    fontWeight: '600',
  },

  // Confetti particle
  particle: {
    position: 'absolute',
    top: 0,
    width: 8,
    height: 8,
    borderRadius: 2,
  },

  // Drive Photos section
  photoSection: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 4,
  },
  photoSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  photoSectionTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
  },
  photoAddBtn: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '700',
  },
  photoEmptyState: {
    alignItems: 'center',
    paddingVertical: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
    gap: 6,
  },
  photoEmptyIcon: {
    fontSize: 24,
  },
  photoEmptyText: {
    color: colors.textMuted,
    fontSize: 13,
  },
  photoScroll: {
    flexDirection: 'row',
  },
  photoThumb: {
    width: 80,
    height: 80,
    borderRadius: 8,
    marginRight: 8,
  },
  photoAddThumb: {
    width: 80,
    height: 80,
    borderRadius: 8,
    backgroundColor: colors.cardElevated,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoAddThumbIcon: {
    color: colors.textMuted,
    fontSize: 28,
    fontWeight: '300',
  },

  // Photo preview modal
  photoModalBg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoModalClose: {
    position: 'absolute',
    top: 56,
    right: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  photoModalCloseText: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '600',
  },
  photoModalImage: {
    width: SCREEN_W,
    height: SCREEN_H * 0.8,
  },
  });
}

function createAchievementStyles(colors: ThemeColors) {
  return StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: colors.warning,
    padding: 28,
    alignItems: 'center',
    width: '100%',
    maxWidth: 340,
  },
  badge: {
    fontSize: 64,
    marginBottom: 12,
  },
  unlockLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.warning,
    textTransform: 'uppercase',
    letterSpacing: 2,
    marginBottom: 6,
  },
  achievementName: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.text,
    textAlign: 'center',
    marginBottom: 8,
  },
  achievementDesc: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
  },
  doneBtn: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 40,
    alignItems: 'center',
  },
  doneBtnText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  });
}

function createExtraStyles(colors: ThemeColors) {
  return StyleSheet.create({
  streakBanner: {
    backgroundColor: '#1A1200',
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 4,
  },
  streakText: {
    color: colors.warning,
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
  secondaryRow: {
    flexDirection: 'row',
    gap: 10,
  },
  secondaryBtn: {
    flex: 1,
    backgroundColor: colors.cardElevated,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center' as const,
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryBtnText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  socialPrompt: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 10,
  },
  socialPromptText: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  inviteBtn: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center' as const,
  },
  inviteBtnText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
  },
  });
}
