import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Dimensions,
  Image,
  Modal,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------
const T = {
  bg: '#0A0A0A',
  card: '#1C1C1C',
  cardElevated: '#242424',
  border: '#2A2A2A',
  accent: '#DC143C',
  text: '#FFFFFF',
  muted: '#888888',
  success: '#22C55E',
} as const;

// ---------------------------------------------------------------------------
// Confetti burst — 24 particles, pure RN Animated, no third-party lib
// ---------------------------------------------------------------------------

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const CONFETTI_COLORS = [T.accent, T.text, '#F59E0B', T.success, '#60A5FA', '#A78BFA'];
const PARTICLE_COUNT = 24;

interface Particle {
  x: number;
  color: string;
  translateY: Animated.Value;
  translateX: Animated.Value;
  opacity: Animated.Value;
  rotate: Animated.Value;
}

function useConfetti(): Particle[] {
  return useMemo(
    () =>
      Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
        x: (SCREEN_W / PARTICLE_COUNT) * i + Math.random() * 30 - 15,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        translateY: new Animated.Value(-20),
        translateX: new Animated.Value(0),
        opacity: new Animated.Value(1),
        rotate: new Animated.Value(0),
      })),
    [],
  );
}

function Confetti() {
  const particles = useConfetti();

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
              styles.particle,
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
    `🏁 Just finished a convoy with ${groupName} on CONVOY!`,
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
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return (
    <View style={shareCardStyles.card}>
      <View style={shareCardStyles.header}>
        <Text style={shareCardStyles.wordmark}>CONVOY</Text>
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

const shareCardStyles = StyleSheet.create({
  card: {
    backgroundColor: '#111111',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DC143C',
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
    color: '#DC143C',
    fontWeight: '900',
    fontSize: 18,
    letterSpacing: 3,
  },
  flag: { fontSize: 22 },
  groupName: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 2,
  },
  date: {
    color: '#888888',
    fontSize: 12,
    marginBottom: 12,
  },
  divider: {
    height: 1,
    backgroundColor: '#2A2A2A',
    marginBottom: 12,
  },
  statsLine: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
  },
  speedLine: {
    color: '#888888',
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
    backgroundColor: '#22C55E',
  },
  line: {
    flex: 1,
    height: 2,
    backgroundColor: '#DC143C',
    marginHorizontal: 6,
  },
  flag2: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#DC143C',
  },
  url: {
    color: '#888888',
    fontSize: 11,
    textAlign: 'right',
    letterSpacing: 0.5,
  },
});

// ---------------------------------------------------------------------------
// StatCard — one of three horizontal cards
// ---------------------------------------------------------------------------

interface StatCardProps {
  emoji: string;
  label: string;
  value: string;
}

function StatCard({ emoji, label, value }: StatCardProps) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statEmoji}>{emoji}</Text>
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
  return (
    <View style={styles.routeCard}>
      {hasTrace ? (
        <View style={styles.routeTracePlaceholder}>
          <View style={styles.routeLineLeft} />
          <View style={styles.routeDot} />
          <View style={styles.routeLineRight} />
        </View>
      ) : (
        <Text style={styles.routeNoTraceIcon}>🗺️</Text>
      )}
      <Text style={styles.routeLabel}>Route Summary</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function ConvoyEndScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const {
    groupName,
    durationMinutes,
    distanceM,
    memberCount,
    topSpeedKmh,
    routeTrace,
  } = useLocalSearchParams<{
    groupName: string;
    durationMinutes: string;
    distanceM: string;
    memberCount: string;
    topSpeedKmh?: string;
    routeTrace?: string;
  }>();

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
              '❤️ Loving CONVOY?',
              'A quick rating helps us grow the community of drivers.',
              [
                {
                  text: '⭐ Rate 5 Stars',
                  onPress: async () => {
                    await AsyncStorage.setItem('convoy:has_reviewed', 'true');
                    // Opens App Store page — replace with real app ID before launch
                    const { Linking } = require('react-native');
                    Linking.openURL('https://apps.apple.com/app/id000000000');
                  },
                },
                { text: 'Maybe Later', style: 'cancel' },
              ],
            );
          }, 3000);
        }
      } catch {}
    }
    maybeAskForReview();
  }, []);

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

  const shareText = buildShareText(distanceKmText, formatDuration(duration), members, topSpeed, displayGroup)
    + (photos.length > 0 ? `\n📸 ${photos.length} photo${photos.length !== 1 ? 's' : ''} from the drive` : '');

  const savePhotos = async (newPhotos: string[]) => {
    try {
      await AsyncStorage.setItem(`convoy:drive:${driveId}:photos`, JSON.stringify(newPhotos));
    } catch {}
  };

  const pickFromLibrary = () => {
    Alert.alert(
      'Add Drive Photos',
      'Photo upload coming soon! You\'ll be able to add photos from your drive in the next update.',
      [{ text: 'Got it', style: 'default' }],
    );
  };

  const handleShare = async () => {
    try {
      await Share.share({
        title: 'My CONVOY drive',
        message: shareText,
      });
      setShared(true);
    } catch {
      // User cancelled — swallow silently
    }
  };

  const handleSaveToPhotos = () => {
    Alert.alert('Coming Soon', 'Screenshot sharing will be available in the next update.');
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

      {/* Full-screen photo preview modal */}
      <Modal visible={previewPhoto !== null} transparent animationType="fade" onRequestClose={() => setPreviewPhoto(null)}>
        <View style={styles.photoModalBg}>
          <TouchableOpacity style={styles.photoModalClose} onPress={() => setPreviewPhoto(null)}>
            <Text style={styles.photoModalCloseText}>✕</Text>
          </TouchableOpacity>
          {previewPhoto && (
            <Image source={{ uri: previewPhoto }} style={styles.photoModalImage} resizeMode="contain" />
          )}
        </View>
      </Modal>

      {/* Body */}
      <View style={styles.inner}>
        {/* Trophy — Animated.spring scale 0 → 1 */}
        <Animated.Text
          style={[
            styles.trophyEmoji,
            { transform: [{ scale }], opacity: iconOpacity },
          ]}
        >
          🏆
        </Animated.Text>

        <Animated.View style={[styles.contentBlock, { opacity: contentOpacity }]}>
          <Text style={styles.title}>Convoy Complete</Text>
          <Text style={styles.subtitle}>
            Great drive with{' '}
            <Text style={styles.groupName}>{displayGroup}</Text>
          </Text>

          {/* 3-stat row: Duration · Distance · Members */}
          <View style={styles.statsRow}>
            <StatCard emoji="⏱" label="Duration" value={formatDuration(duration)} />
            <StatCard emoji="📏" label="Distance" value={formatDistance(distance)} />
            <StatCard emoji="👥" label="Members" value={`${members}`} />
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
            <Text style={styles.photoSectionTitle}>📸 Drive Photos</Text>
            <TouchableOpacity onPress={pickFromLibrary} accessibilityLabel="Add drive photos">
              <Text style={styles.photoAddBtn}>+ Add</Text>
            </TouchableOpacity>
          </View>
          {photos.length === 0 ? (
            <TouchableOpacity style={styles.photoEmptyState} onPress={pickFromLibrary}>
              <Text style={styles.photoEmptyIcon}>📷</Text>
              <Text style={styles.photoEmptyText}>Add photos from today's drive</Text>
            </TouchableOpacity>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.photoScroll}>
              {photos.map((uri, idx) => (
                <TouchableOpacity key={idx} onPress={() => setPreviewPhoto(uri)}>
                  <Image source={{ uri }} style={styles.photoThumb} resizeMode="cover" />
                </TouchableOpacity>
              ))}
              <TouchableOpacity style={styles.photoAddThumb} onPress={pickFromLibrary}>
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
            <Text style={extraStyles.secondaryBtnText}>📷 Save</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={extraStyles.secondaryBtn}
            onPress={handleCopy}
            accessibilityRole="button"
            accessibilityLabel={copied ? 'Copied to clipboard' : 'Copy stats to clipboard'}
          >
            <Text style={extraStyles.secondaryBtnText}>{copied ? '✓ Copied!' : '📋 Copy text'}</Text>
          </TouchableOpacity>
        </View>

        {/* Post-share social prompt */}
        {shared && (
          <View style={extraStyles.socialPrompt}>
            <Text style={extraStyles.socialPromptText}>
              Tell your crew about CONVOY — invite them to your next drive!
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: T.bg,
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
    fontSize: 80,
    marginBottom: 20,
    textAlign: 'center',
  },

  // Headline
  title: {
    fontSize: 30,
    fontWeight: '800',
    color: T.text,
    textAlign: 'center',
    marginBottom: 6,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 15,
    color: T.muted,
    textAlign: 'center',
    marginBottom: 28,
  },
  groupName: {
    color: T.accent,
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
    backgroundColor: T.card,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 6,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: T.border,
  },
  statEmoji: {
    fontSize: 20,
    marginBottom: 6,
  },
  statValue: {
    fontSize: 16,
    fontWeight: '700',
    color: T.text,
    marginBottom: 3,
    textAlign: 'center',
  },
  statLabel: {
    fontSize: 10,
    color: T.muted,
    textAlign: 'center',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },

  // Route summary card
  routeCard: {
    width: '100%',
    backgroundColor: T.cardElevated,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: T.border,
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
    backgroundColor: T.accent,
    borderRadius: 1,
  },
  routeDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: T.success,
    marginHorizontal: 4,
  },
  routeLineRight: {
    flex: 1,
    height: 2,
    backgroundColor: T.muted,
    borderRadius: 1,
    opacity: 0.5,
  },
  routeNoTraceIcon: {
    fontSize: 32,
    marginBottom: 10,
  },
  routeLabel: {
    fontSize: 11,
    color: T.muted,
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
    backgroundColor: T.accent,
    borderRadius: 14,
    height: 52,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareBtnText: {
    color: T.text,
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
    color: T.muted,
    fontSize: 13,
    fontWeight: '500',
  },

  primaryBtn: {
    backgroundColor: T.accent,
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
  },
  primaryBtnText: {
    color: T.text,
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
    borderColor: T.border,
    minHeight: 52,
  },
  ghostBtnText: {
    color: T.muted,
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
    backgroundColor: T.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: T.border,
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
    color: T.text,
    fontSize: 14,
    fontWeight: '700',
  },
  photoAddBtn: {
    color: T.accent,
    fontSize: 14,
    fontWeight: '700',
  },
  photoEmptyState: {
    alignItems: 'center',
    paddingVertical: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: T.border,
    borderStyle: 'dashed',
    gap: 6,
  },
  photoEmptyIcon: {
    fontSize: 24,
  },
  photoEmptyText: {
    color: T.muted,
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
    backgroundColor: T.cardElevated,
    borderWidth: 1,
    borderColor: T.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoAddThumbIcon: {
    color: T.muted,
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
    color: T.text,
    fontSize: 18,
    fontWeight: '600',
  },
  photoModalImage: {
    width: SCREEN_W,
    height: SCREEN_H * 0.8,
  },
});

const extraStyles = StyleSheet.create({
  streakBanner: {
    backgroundColor: '#1A1200',
    borderWidth: 1,
    borderColor: '#F59E0B',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 4,
  },
  streakText: {
    color: '#F59E0B',
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
    backgroundColor: '#242424',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center' as const,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  secondaryBtnText: {
    color: '#888888',
    fontSize: 13,
    fontWeight: '600',
  },
  socialPrompt: {
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    gap: 10,
  },
  socialPromptText: {
    color: '#888888',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  inviteBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center' as const,
  },
  inviteBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
});
