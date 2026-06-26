import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
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
): string {
  const lines: string[] = [
    '🏁 Just finished a CONVOY ride!',
    `📍 ${distanceKm} in ${duration}`,
    `👥 ${members} rider${members !== 1 ? 's' : ''} strong`,
  ];
  if (topSpeed != null) {
    lines.push(`🏎️ Top speed: ${topSpeed} km/h`);
  }
  lines.push('Download CONVOY and join the fun!');
  return lines.join('\n');
}

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

  // Copy toast state
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const shareText = buildShareText(distanceKmText, formatDuration(duration), members, topSpeed);

  const handleShare = async () => {
    try {
      await Share.share({ message: shareText });
    } catch {
      // User cancelled or share sheet unavailable — swallow silently
    }
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
        {/* Share Your Ride — full-width crimson share button */}
        <TouchableOpacity
          style={styles.shareBtn}
          onPress={handleShare}
          accessibilityRole="button"
          accessibilityLabel="Share your ride summary"
        >
          <Text style={styles.shareBtnText}>Share Your Ride 🚀</Text>
        </TouchableOpacity>

        {/* Copy text link — small muted link, shows Copied! toast for 2s */}
        <TouchableOpacity
          style={styles.copyLink}
          onPress={handleCopy}
          accessibilityRole="button"
          accessibilityLabel={copied ? 'Copied to clipboard' : 'Copy stats to clipboard'}
        >
          <Text style={styles.copyLinkText}>{copied ? 'Copied!' : 'Copy text'}</Text>
        </TouchableOpacity>

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

  // Copy text — small muted link below share button
  copyLink: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 2,
    marginTop: -4, // tighten gap with share button
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
});
