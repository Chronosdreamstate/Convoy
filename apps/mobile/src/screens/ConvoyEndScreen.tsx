import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Dimensions,
  SafeAreaView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

// ---------------------------------------------------------------------------
// Confetti burst — 24 particles, pure RN Animated, no third-party lib
// ---------------------------------------------------------------------------

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const CONFETTI_COLORS = ['#DC143C', '#FFFFFF', '#F59E0B', '#22C55E', '#60A5FA', '#A78BFA'];
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
          toValue: SCREEN_H * 0.7,
          duration: 2000 + Math.random() * 1000,
          delay: i * 60,
          useNativeDriver: true,
        }),
        Animated.timing(p.translateX, {
          toValue: (Math.random() - 0.5) * 80,
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
                transform: [{ translateY: p.translateY }, { translateX: p.translateX }, { rotate: spin }],
              },
            ]}
          />
        );
      })}
    </View>
  );
}

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

interface StatCardProps {
  emoji: string;
  label: string;
  value: string;
}

function StatCard({ emoji, label, value }: StatCardProps) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statEmoji}>{emoji}</Text>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

export default function ConvoyEndScreen() {
  const router = useRouter();
  const { groupName, durationMinutes, distanceM, memberCount, adminName } =
    useLocalSearchParams<{
      groupName: string;
      durationMinutes: string;
      distanceM: string;
      memberCount: string;
      adminName: string;
    }>();

  const scale = useRef(new Animated.Value(0.4)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const contentOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.parallel([
        Animated.spring(scale, { toValue: 1.15, useNativeDriver: true, tension: 200, friction: 8 }),
        Animated.timing(opacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      ]),
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, tension: 150, friction: 10 }),
    ]).start();

    Animated.timing(contentOpacity, {
      toValue: 1,
      duration: 500,
      delay: 250,
      useNativeDriver: true,
    }).start();
  }, []);

  const duration = parseInt(durationMinutes ?? '0', 10);
  const distance = parseInt(distanceM ?? '0', 10);
  const members = parseInt(memberCount ?? '1', 10);

  const handleShare = () => {
    void Share.share({
      message: `Just finished a ${formatDistance(distance)} convoy on CONVOY with ${members} driver${members !== 1 ? 's' : ''}! 🚗 Check out the app.`,
    });
  };

  return (
    <SafeAreaView style={styles.container}>
      <Confetti />
      <View style={styles.inner}>
        {/* Celebration emoji */}
        <Animated.Text style={[styles.flagEmoji, { transform: [{ scale }], opacity }]}>
          🏁
        </Animated.Text>

        <Animated.View style={{ opacity: contentOpacity }}>
          <Text style={styles.title}>Convoy Complete!</Text>
          <Text style={styles.subtitle}>
            Great drive with{' '}
            <Text style={styles.groupName}>{groupName ?? 'your crew'}</Text>
          </Text>

          {/* Stats grid */}
          <View style={styles.grid}>
            <StatCard emoji="🕐" label="Duration" value={formatDuration(duration)} />
            <StatCard emoji="📏" label="Distance" value={formatDistance(distance)} />
            <StatCard emoji="👥" label="Members" value={`${members} driver${members !== 1 ? 's' : ''}`} />
            <StatCard emoji="👑" label="Led by" value={adminName ?? '—'} />
          </View>

          {/* Share */}
          <TouchableOpacity
            style={styles.shareBtn}
            onPress={handleShare}
            accessibilityRole="button"
            accessibilityLabel="Share this drive"
          >
            <Text style={styles.shareBtnText}>📤  Share this drive</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>

      {/* Anchored footer buttons */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={styles.secondaryBtn}
          onPress={() => router.replace('/(tabs)/drives' as never)}
          accessibilityRole="button"
          accessibilityLabel="View drive history"
        >
          <Text style={styles.secondaryBtnText}>📋  Drive History</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={() => router.replace('/(tabs)/map')}
          accessibilityRole="button"
          accessibilityLabel="Back to map"
        >
          <Text style={styles.primaryBtnText}>Back to Map</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  inner: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  flagEmoji: {
    fontSize: 64,
    marginBottom: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: '#FFFFFF',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#888888',
    textAlign: 'center',
    marginBottom: 32,
  },
  groupName: {
    color: '#DC143C',
    fontWeight: '700',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'center',
    marginBottom: 32,
  },
  statCard: {
    width: '45%',
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  statEmoji: {
    fontSize: 24,
    marginBottom: 6,
  },
  statValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
    marginBottom: 4,
    textAlign: 'center',
  },
  statLabel: {
    fontSize: 12,
    color: '#888888',
    textAlign: 'center',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  shareBtn: {
    borderWidth: 1,
    borderColor: '#DC143C',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 32,
    alignItems: 'center',
    minHeight: 52,
  },
  shareBtnText: {
    color: '#DC143C',
    fontSize: 16,
    fontWeight: '600',
  },
  footer: {
    paddingHorizontal: 24,
    paddingBottom: 16,
    gap: 10,
  },
  secondaryBtn: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
    minHeight: 52,
    justifyContent: 'center',
  },
  secondaryBtnText: {
    color: '#888888',
    fontSize: 15,
    fontWeight: '600',
  },
  primaryBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
    minHeight: 56,
    justifyContent: 'center',
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
  },
  particle: {
    position: 'absolute',
    top: 0,
    width: 8,
    height: 8,
    borderRadius: 2,
  },
});
