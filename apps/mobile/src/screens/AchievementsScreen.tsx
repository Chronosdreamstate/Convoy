import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Modal,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { theme } from '../theme';
import { apiClient } from '../services/apiClient';

// ---------------------------------------------------------------------------
// Achievement definitions
// ---------------------------------------------------------------------------

interface Achievement {
  id: string;
  icon: string;
  name: string;
  desc: string;
  unlocked: boolean;
  progress: number;
  total: number;
}

const ACHIEVEMENTS: Achievement[] = [
  { id: 'first_convoy', icon: '🏁', name: 'First Convoy', desc: 'Complete your first convoy', unlocked: false, progress: 0, total: 1 },
  { id: 'convoy_10', icon: '🎖️', name: 'Road Warrior', desc: 'Complete 10 convoys', unlocked: false, progress: 3, total: 10 },
  { id: 'convoy_50', icon: '⭐', name: 'Legend', desc: 'Complete 50 convoys', unlocked: false, progress: 3, total: 50 },
  { id: 'distance_100', icon: '🛣️', name: 'Century Rider', desc: 'Drive 100km in convoys', unlocked: false, progress: 47, total: 100 },
  { id: 'distance_1000', icon: '🌍', name: 'Globe Trotter', desc: 'Drive 1,000km in convoys', unlocked: false, progress: 47, total: 1000 },
  { id: 'sos_hero', icon: '🆘', name: 'Road Angel', desc: 'Respond to an SOS alert', unlocked: false, progress: 0, total: 1 },
  { id: 'streak_7', icon: '🔥', name: 'On Fire', desc: '7-day convoy streak', unlocked: false, progress: 2, total: 7 },
  { id: 'group_founder', icon: '👑', name: 'Founder', desc: 'Create a group', unlocked: false, progress: 0, total: 1 },
  { id: 'ptt_master', icon: '📻', name: 'Radio Master', desc: 'Use PTT 100 times', unlocked: false, progress: 23, total: 100 },
  { id: 'waypoint_setter', icon: '📍', name: 'Pathfinder', desc: 'Add 10 waypoints', unlocked: false, progress: 4, total: 10 },
  { id: 'night_owl', icon: '🌙', name: 'Night Owl', desc: 'Complete a convoy after midnight', unlocked: false, progress: 0, total: 1 },
  { id: 'photo_sharer', icon: '📸', name: 'Photographer', desc: 'Share 5 drive photos', unlocked: false, progress: 0, total: 5 },
];

const NUM_COLUMNS = 3;

// ---------------------------------------------------------------------------
// Achievement Card (grid cell)
// ---------------------------------------------------------------------------

interface AchievementCardProps {
  item: Achievement;
  onPress: (item: Achievement) => void;
}

function AchievementCard({ item, onPress }: AchievementCardProps) {
  const isLocked = !item.unlocked;
  return (
    <TouchableOpacity
      style={[
        styles.card,
        item.unlocked && styles.cardUnlocked,
        isLocked && styles.cardLocked,
      ]}
      onPress={() => onPress(item)}
      accessibilityRole="button"
      accessibilityLabel={`${item.name} — ${item.unlocked ? 'unlocked' : 'locked'}`}
    >
      {/* Icon */}
      <View style={styles.iconWrapper}>
        <Text style={styles.iconText}>{item.icon}</Text>
        {isLocked && (
          <Text style={styles.lockOverlay}>🔒</Text>
        )}
      </View>
      {/* Name */}
      <Text style={[styles.cardName, isLocked && styles.cardNameLocked]} numberOfLines={2}>
        {item.name}
      </Text>
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

function ProgressBar({ progress, total }: { progress: number; total: number }) {
  const pct = Math.min(progress / total, 1);
  return (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, { width: `${pct * 100}%` as `${number}%` }]} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Detail bottom modal
// ---------------------------------------------------------------------------

interface DetailModalProps {
  item: Achievement | null;
  onClose: () => void;
}

function DetailModal({ item, onClose }: DetailModalProps) {
  const slideAnim = useRef(new Animated.Value(300)).current;

  React.useEffect(() => {
    if (item) {
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 120,
        friction: 9,
      }).start();
    } else {
      slideAnim.setValue(300);
    }
  }, [item]);

  if (!item) return null;

  const hasProgress = item.total > 1;
  const isLocked = !item.unlocked;

  return (
    <Modal
      visible={item !== null}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={onClose} />
      <Animated.View style={[styles.modalSheet, { transform: [{ translateY: slideAnim }] }]}>
        {/* Handle */}
        <View style={styles.modalHandle} />

        {/* Icon */}
        <View style={[styles.modalIconWrapper, isLocked && styles.modalIconWrapperLocked]}>
          <Text style={styles.modalIcon}>{item.icon}</Text>
          {isLocked && <Text style={styles.modalLockBadge}>🔒</Text>}
        </View>

        {/* Name */}
        <Text style={styles.modalName}>{item.name}</Text>

        {/* Desc */}
        <Text style={styles.modalDesc}>{item.desc}</Text>

        {/* Status badge */}
        <View style={[styles.statusBadge, item.unlocked ? styles.statusBadgeUnlocked : styles.statusBadgeLocked]}>
          <Text style={[styles.statusBadgeText, item.unlocked ? styles.statusBadgeTextUnlocked : styles.statusBadgeTextLocked]}>
            {item.unlocked ? '✓ Unlocked' : 'Locked'}
          </Text>
        </View>

        {/* Progress (only for multi-step achievements that aren't unlocked) */}
        {hasProgress && !item.unlocked && (
          <View style={styles.modalProgressSection}>
            <View style={styles.modalProgressLabelRow}>
              <Text style={styles.modalProgressLabel}>Progress</Text>
              <Text style={styles.modalProgressCount}>{item.progress} of {item.total}</Text>
            </View>
            <ProgressBar progress={item.progress} total={item.total} />
          </View>
        )}

        {/* Close */}
        <TouchableOpacity style={styles.modalCloseBtn} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
          <Text style={styles.modalCloseBtnText}>Close</Text>
        </TouchableOpacity>
      </Animated.View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

interface AchievementProgress { id: string; unlocked: boolean; progress: number; total: number }

export default function AchievementsScreen() {
  const [achievements, setAchievements] = useState<Achievement[]>(ACHIEVEMENTS);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Achievement | null>(null);

  useEffect(() => {
    apiClient.get<{ achievements: AchievementProgress[] }>('/api/v1/users/me/achievements')
      .then((res) => {
        const progressMap = new Map(res.data.achievements.map((a) => [a.id, a]));
        setAchievements(ACHIEVEMENTS.map((a) => {
          const p = progressMap.get(a.id);
          return p ? { ...a, unlocked: p.unlocked, progress: p.progress, total: p.total } : a;
        }));
      })
      .catch(() => { /* keep static fallback */ })
      .finally(() => setLoading(false));
  }, []);

  const unlockedCount = achievements.filter((a) => a.unlocked).length;

  const renderItem = ({ item }: { item: Achievement }) => (
    <AchievementCard item={item} onPress={setSelected} />
  );

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Achievements</Text>
        <View style={styles.headerBadge}>
          <Text style={styles.headerBadgeText}>{unlockedCount} / {achievements.length} unlocked</Text>
        </View>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.colors.accent} size="large" />
        </View>
      ) : (
        <FlatList
          data={achievements}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          numColumns={NUM_COLUMNS}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}

      {/* Detail modal */}
      <DetailModal item={selected} onClose={() => setSelected(null)} />
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const CARD_SIZE = '30%';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 16,
  },
  headerTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: theme.colors.text,
    letterSpacing: -0.5,
  },
  headerBadge: {
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  headerBadgeText: {
    color: theme.colors.text,
    fontSize: 12,
    fontWeight: '700',
  },

  // Grid
  listContent: {
    paddingHorizontal: 12,
    paddingBottom: 32,
  },
  row: {
    justifyContent: 'space-between',
    marginBottom: 10,
  },

  // Achievement card
  card: {
    width: CARD_SIZE,
    aspectRatio: 0.9,
    backgroundColor: theme.colors.card,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 6,
    gap: 6,
  },
  cardUnlocked: {
    borderColor: '#F59E0B',
    borderWidth: 1,
  },
  cardLocked: {
    opacity: 0.35,
  },
  iconWrapper: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: {
    fontSize: 32,
  },
  lockOverlay: {
    position: 'absolute',
    fontSize: 14,
    bottom: -4,
    right: -4,
    opacity: 0.5,
  },
  cardName: {
    fontSize: 11,
    fontWeight: '600',
    color: theme.colors.text,
    textAlign: 'center',
    lineHeight: 14,
  },
  cardNameLocked: {
    color: theme.colors.textMuted,
  },

  // Progress bar
  progressTrack: {
    width: '100%',
    height: 4,
    backgroundColor: theme.colors.border,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: theme.colors.accent,
    borderRadius: 2,
  },

  // Modal backdrop
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },

  // Bottom sheet
  modalSheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: theme.colors.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 24,
    paddingBottom: 36,
    paddingTop: 12,
    alignItems: 'center',
    borderTopWidth: 1,
    borderColor: theme.colors.border,
  },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.border,
    marginBottom: 20,
  },
  modalIconWrapper: {
    width: 88,
    height: 88,
    borderRadius: 20,
    backgroundColor: theme.colors.cardElevated,
    borderWidth: 1.5,
    borderColor: '#F59E0B',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
    position: 'relative',
  },
  modalIconWrapperLocked: {
    borderColor: theme.colors.border,
    opacity: 0.5,
  },
  modalIcon: {
    fontSize: 44,
  },
  modalLockBadge: {
    position: 'absolute',
    bottom: -6,
    right: -6,
    fontSize: 18,
    opacity: 0.7,
  },
  modalName: {
    fontSize: 20,
    fontWeight: '700',
    color: theme.colors.text,
    textAlign: 'center',
    marginBottom: 6,
  },
  modalDesc: {
    fontSize: 14,
    color: theme.colors.textMuted,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 16,
  },
  statusBadge: {
    borderRadius: theme.radius.pill,
    paddingHorizontal: 16,
    paddingVertical: 6,
    marginBottom: 16,
  },
  statusBadgeUnlocked: {
    backgroundColor: 'rgba(34,197,94,0.15)',
    borderWidth: 1,
    borderColor: theme.colors.success,
  },
  statusBadgeLocked: {
    backgroundColor: 'rgba(136,136,136,0.15)',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  statusBadgeText: {
    fontSize: 13,
    fontWeight: '700',
  },
  statusBadgeTextUnlocked: {
    color: theme.colors.success,
  },
  statusBadgeTextLocked: {
    color: theme.colors.textMuted,
  },
  modalProgressSection: {
    width: '100%',
    marginBottom: 16,
    gap: 8,
  },
  modalProgressLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modalProgressLabel: {
    fontSize: 13,
    color: theme.colors.textMuted,
    fontWeight: '600',
  },
  modalProgressCount: {
    fontSize: 13,
    color: theme.colors.text,
    fontWeight: '700',
  },
  modalCloseBtn: {
    width: '100%',
    backgroundColor: theme.colors.cardElevated,
    borderRadius: theme.radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginTop: 4,
  },
  modalCloseBtnText: {
    color: theme.colors.textMuted,
    fontSize: 15,
    fontWeight: '600',
  },
});
