import React, { useEffect, useRef } from 'react';
import {
  Animated,
  SafeAreaView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

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

      {/* Back to map — anchored at bottom */}
      <View style={styles.footer}>
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
});
