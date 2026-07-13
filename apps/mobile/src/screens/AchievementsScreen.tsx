import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Modal,
  RefreshControl,
  SafeAreaView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { ThemeColors, useTheme } from '../theme';
import { apiClient } from '../services/apiClient';
import { MotionCapNotice, useMotionCappedData } from '../components/MotionAwareList';
import { SkeletonBox } from '../components/SkeletonLoader';
import { useReduceMotion } from '../hooks/useReduceMotion';

// Fixed white for text sitting on the accent fill — the accent color is the
// same in both themes, while colors.text flips to near-black in light mode
// and would be unreadable on this fill (ON_ACCENT convention).
const ON_ACCENT = '#FFFFFF';

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

// NOTE: `unlocked`/`progress` below are placeholder values only — they are what
// renders if the /api/v1/users/me/achievements call fails (see fetchAchievements
// below). They must stay at "no progress yet" so a network error can't make up
// fake accomplishments for the user; real values always come from the API.
//
// NOTE: `icon` here is the achievement's collectible badge emoji — intentionally
// playful content, not UI chrome. Leave these as emoji.
const ACHIEVEMENTS: Achievement[] = [
  { id: 'first_convoy', icon: '🏁', name: 'First Convoy', desc: 'Complete your first convoy', unlocked: false, progress: 0, total: 1 },
  { id: 'convoy_10', icon: '🎖️', name: 'Road Warrior', desc: 'Complete 10 convoys', unlocked: false, progress: 0, total: 10 },
  { id: 'convoy_50', icon: '⭐', name: 'Legend', desc: 'Complete 50 convoys', unlocked: false, progress: 0, total: 50 },
  { id: 'distance_100', icon: '🛣️', name: 'Century Rider', desc: 'Drive 100km in convoys', unlocked: false, progress: 0, total: 100 },
  { id: 'distance_1000', icon: '🌍', name: 'Globe Trotter', desc: 'Drive 1,000km in convoys', unlocked: false, progress: 0, total: 1000 },
  { id: 'sos_hero', icon: '🆘', name: 'Road Angel', desc: 'Respond to an SOS alert', unlocked: false, progress: 0, total: 1 },
  { id: 'streak_7', icon: '🔥', name: 'On Fire', desc: '7-day convoy streak', unlocked: false, progress: 0, total: 7 },
  { id: 'group_founder', icon: '👑', name: 'Founder', desc: 'Create a group', unlocked: false, progress: 0, total: 1 },
  { id: 'ptt_master', icon: '📻', name: 'Radio Master', desc: 'Use PTT 100 times', unlocked: false, progress: 0, total: 100 },
  { id: 'waypoint_setter', icon: '📍', name: 'Pathfinder', desc: 'Add 10 waypoints', unlocked: false, progress: 0, total: 10 },
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
  styles: Styles;
  colors: ThemeColors;
}

function AchievementCard({ item, onPress, styles, colors }: AchievementCardProps) {
  const isLocked = !item.unlocked;
  // In-progress, multi-step achievements get a thin fill bar at the base of
  // the card so a user at 95/100 reads as nearly-done at a glance, instead of
  // looking identical to one at 2/100 — both previously just "locked, dim".
  const hasVisibleProgress = isLocked && item.total > 1 && item.progress > 0;
  const pct = hasVisibleProgress ? Math.min(item.progress / item.total, 1) : 0;
  const progressLabel = hasVisibleProgress ? `, ${item.progress} of ${item.total} complete` : '';
  return (
    <TouchableOpacity
      style={[
        styles.card,
        item.unlocked && styles.cardUnlocked,
        isLocked && styles.cardLocked,
      ]}
      onPress={() => onPress(item)}
      accessibilityRole="button"
      accessibilityLabel={`${item.name} — ${item.unlocked ? 'unlocked' : 'locked'}${progressLabel}`}
    >
      {/* Icon — badge emoji is intentional collectible content, left as-is */}
      <View style={styles.iconWrapper}>
        <Text style={styles.iconText}>{item.icon}</Text>
        {isLocked && (
          <View style={styles.lockOverlay}>
            <Ionicons name="lock-closed" size={12} color={colors.textMuted} />
          </View>
        )}
      </View>
      {/* Name */}
      <Text style={[styles.cardName, isLocked && styles.cardNameLocked]} numberOfLines={2}>
        {item.name}
      </Text>
      {hasVisibleProgress && (
        <View style={styles.cardProgressTrack}>
          <View style={[styles.cardProgressFill, { width: `${pct * 100}%` as `${number}%` }]} />
        </View>
      )}
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

function ProgressBar({ progress, total, styles }: { progress: number; total: number; styles: Styles }) {
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
  styles: Styles;
  colors: ThemeColors;
}

function DetailModal({ item, onClose, styles, colors }: DetailModalProps) {
  const slideAnim = useRef(new Animated.Value(300)).current;
  // Small celebratory bounce on the badge icon — only for already-unlocked
  // achievements, so opening one feels like a little reward rather than a
  // flat detail view. Locked achievements just settle in at full scale.
  const iconScale = useRef(new Animated.Value(1)).current;
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();

  React.useEffect(() => {
    if (item) {
      if (reduceMotion) {
        // Static equivalent (Req 39–41): the sheet and badge appear in place —
        // no slide-up spring, no celebratory bounce.
        slideAnim.setValue(0);
        iconScale.setValue(1);
        return;
      }
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 120,
        friction: 9,
      }).start();
      if (item.unlocked) {
        iconScale.setValue(0.5);
        Animated.spring(iconScale, {
          toValue: 1,
          useNativeDriver: true,
          tension: 140,
          friction: 6,
        }).start();
      } else {
        iconScale.setValue(1);
      }
    } else {
      slideAnim.setValue(300);
    }
  }, [item, reduceMotion]);

  if (!item) return null;

  const hasProgress = item.total > 1;
  const isLocked = !item.unlocked;

  // Share an unlocked badge as a formatted text brag — mirrors how sharing is
  // invoked elsewhere (RN Share API, e.g. RouteReplay/DriveHistory screens).
  // Share.share resolves on sheet dismissal, so no busy state is needed.
  const handleShare = async () => {
    try {
      await Share.share({
        title: 'CORTEGE Achievement',
        message:
          `${item.icon} Achievement unlocked: ${item.name}!\n` +
          `"${item.desc}" — done. 🏆\n\n` +
          'Join the convoy on CORTEGE: convoy.app/download',
      });
    } catch { /* user cancelled or share sheet unavailable */ }
  };

  return (
    <Modal
      visible={item !== null}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={onClose} accessible={false} />
      <Animated.View
        style={[
          styles.modalSheet,
          { paddingBottom: Math.max(insets.bottom + 16, 36) },
          { transform: [{ translateY: slideAnim }] },
        ]}
      >

        {/* Handle */}
        <View style={styles.modalHandle} />

        {/* Icon — badge emoji is intentional collectible content, left as-is */}
        <Animated.View
          style={[
            styles.modalIconWrapper,
            isLocked && styles.modalIconWrapperLocked,
            { transform: [{ scale: iconScale }] },
          ]}
        >
          <Text style={styles.modalIcon}>{item.icon}</Text>
          {isLocked && (
            <View style={styles.modalLockBadge}>
              <Ionicons name="lock-closed" size={16} color={colors.textMuted} />
            </View>
          )}
        </Animated.View>

        {/* Name */}
        <Text style={styles.modalName}>{item.name}</Text>

        {/* Desc */}
        <Text style={styles.modalDesc}>{item.desc}</Text>

        {/* Status badge */}
        <View style={[styles.statusBadge, item.unlocked ? styles.statusBadgeUnlocked : styles.statusBadgeLocked]}>
          {item.unlocked && (
            <Ionicons name="checkmark-circle" size={14} color={colors.success} style={styles.statusBadgeIcon} />
          )}
          <Text style={[styles.statusBadgeText, item.unlocked ? styles.statusBadgeTextUnlocked : styles.statusBadgeTextLocked]}>
            {item.unlocked ? 'Unlocked' : 'Locked'}
          </Text>
        </View>

        {/* Progress (only for multi-step achievements that aren't unlocked) */}
        {hasProgress && !item.unlocked && (
          <View style={styles.modalProgressSection}>
            <View style={styles.modalProgressLabelRow}>
              <Text style={styles.modalProgressLabel}>Progress</Text>
              <Text style={styles.modalProgressCount}>{item.progress} of {item.total}</Text>
            </View>
            <ProgressBar progress={item.progress} total={item.total} styles={styles} />
          </View>
        )}

        {/* Share (unlocked badges only — locked ones have nothing to brag about yet) */}
        {item.unlocked && (
          <TouchableOpacity
            style={styles.modalShareBtn}
            onPress={() => { void handleShare(); }}
            accessibilityRole="button"
            accessibilityLabel={`Share ${item.name} achievement`}
          >
            <Ionicons name="share-social-outline" size={16} color="#FFFFFF" style={styles.modalShareIcon} />
            <Text style={styles.modalShareBtnText}>Share</Text>
          </TouchableOpacity>
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
  const { colors, spacing, radius } = useTheme();
  const styles = useMemo(() => createStyles(colors, spacing, radius), [colors, spacing, radius]);

  const [achievements, setAchievements] = useState<Achievement[]>(ACHIEVEMENTS);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Achievement | null>(null);
  const [loadError, setLoadError] = useState(false);

  const fetchAchievements = useCallback(async () => {
    try {
      const res = await apiClient.get<{ achievements: AchievementProgress[] }>('/api/v1/users/me/achievements');
      const progressMap = new Map(res.data.achievements.map((a) => [a.id, a]));
      setAchievements(ACHIEVEMENTS.map((a) => {
        const p = progressMap.get(a.id);
        return p ? { ...a, unlocked: p.unlocked, progress: p.progress, total: p.total } : a;
      }));
      setLoadError(false);
    } catch {
      // Keep the safe "no progress yet" static fallback (see ACHIEVEMENTS note
      // above) — but still tell the user this is a load failure, not their
      // real progress, so a network blip doesn't read as lost achievements.
      setLoadError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void fetchAchievements(); }, [fetchAchievements]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void fetchAchievements();
  }, [fetchAchievements]);

  const unlockedCount = achievements.filter((a) => a.unlocked).length;

  // Req 33 — the achievements grid is still a scrollable list on the phone
  // screen, so cap it to 4 badges while the vehicle is in motion (see
  // MotionAwareList). The unlocked count above still reflects the full set.
  const { data: visibleAchievements, hiddenCount } = useMotionCappedData(achievements);

  const renderItem = useCallback(({ item }: { item: Achievement }) => (
    <AchievementCard item={item} onPress={setSelected} styles={styles} colors={colors} />
  ), [styles, colors]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Achievements</Text>
        <View style={styles.headerBadge}>
          <Text style={styles.headerBadgeText}>{unlockedCount} / {achievements.length} unlocked</Text>
        </View>
      </View>

      {!loading && loadError ? (
        <View style={styles.loadErrorRow}>
          <Text style={styles.loadErrorText}>
            Couldn't load your latest progress.
          </Text>
          <TouchableOpacity
            onPress={handleRefresh}
            accessibilityRole="button"
            accessibilityLabel="Retry loading achievements"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.loadErrorRetry}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.skeletonGrid}>
          {Array.from({ length: 9 }).map((_, i) => (
            <View key={i} style={styles.skeletonCard}>
              <SkeletonBox width={40} height={40} borderRadius={10} />
              <SkeletonBox width="70%" height={10} />
            </View>
          ))}
        </View>
      ) : (
        <FlatList
          data={visibleAchievements}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          numColumns={NUM_COLUMNS}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.listContent}
          ListFooterComponent={<MotionCapNotice hiddenCount={hiddenCount} />}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={colors.accent}
              colors={[colors.accent]}
            />
          }
        />
      )}

      <DetailModal item={selected} onClose={() => setSelected(null)} styles={styles} colors={colors} />
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const CARD_SIZE = '30%';

function createStyles(colors: ThemeColors, spacing: { xs: number; sm: number; md: number; lg: number; xl: number; xxl: number }, radius: { sm: number; md: number; lg: number; xl: number; pill: number }) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.bg,
    },
    skeletonGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      paddingHorizontal: 12,
      gap: 10,
    },
    skeletonCard: {
      width: CARD_SIZE,
      aspectRatio: 0.9,
      backgroundColor: colors.card,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
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
      color: colors.text,
      letterSpacing: -0.5,
    },
    headerBadge: {
      backgroundColor: colors.accent,
      borderRadius: radius.pill,
      paddingHorizontal: 12,
      paddingVertical: 5,
    },
    headerBadgeText: {
      color: ON_ACCENT,
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
      backgroundColor: colors.card,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 14,
      paddingHorizontal: 6,
      gap: 6,
    },
    cardUnlocked: {
      borderColor: colors.warning,
      borderWidth: 1,
    },
    // Recede locked cards with a darker fill instead of a flat opacity
    // multiply — opacity was stacking with cardNameLocked's already-muted
    // text color and crushing the name below readable contrast. A darker
    // background (vs. the unlocked card's normal `colors.card`) still reads
    // as visually receded while keeping the muted text legible.
    cardLocked: {
      backgroundColor: colors.bg,
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
      bottom: -4,
      right: -4,
      backgroundColor: colors.card,
      borderRadius: 8,
      padding: 2,
    },
    cardName: {
      fontSize: 11,
      fontWeight: '600',
      color: colors.text,
      textAlign: 'center',
      lineHeight: 14,
    },
    cardNameLocked: {
      color: colors.textMuted,
    },

    // Thin at-a-glance progress cue on in-progress (but still locked) grid
    // cards — lets a near-complete achievement read as "almost there"
    // without opening the detail modal.
    cardProgressTrack: {
      width: '100%',
      height: 3,
      borderRadius: 1.5,
      backgroundColor: colors.border,
      overflow: 'hidden',
      marginTop: 2,
    },
    cardProgressFill: {
      height: '100%',
      backgroundColor: colors.accent,
      borderRadius: 1.5,
    },

    // Load-failure banner — the fallback data intentionally shows zero
    // progress on error (see ACHIEVEMENTS note), so this makes clear that's
    // a load failure and not the user's real (lost) progress. Pairs with an
    // explicit Retry tap (in addition to pull-to-refresh) so the error state
    // isn't only actionable via a gesture the user has to discover.
    loadErrorRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginHorizontal: 20,
      marginBottom: 12,
    },
    loadErrorText: {
      color: colors.accent,
      fontSize: 12,
      textAlign: 'center',
    },
    loadErrorRetry: {
      color: colors.accent,
      fontSize: 12,
      fontWeight: '700',
      textDecorationLine: 'underline',
    },

    // Progress bar
    progressTrack: {
      width: '100%',
      height: 4,
      backgroundColor: colors.border,
      borderRadius: 2,
      overflow: 'hidden',
    },
    progressFill: {
      height: '100%',
      backgroundColor: colors.accent,
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
      backgroundColor: colors.card,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      paddingHorizontal: 24,
      paddingTop: 12,
      alignItems: 'center',
      borderTopWidth: 1,
      borderColor: colors.border,
    },
    modalHandle: {
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.border,
      marginBottom: 20,
    },
    modalIconWrapper: {
      width: 88,
      height: 88,
      borderRadius: 20,
      backgroundColor: colors.cardElevated,
      borderWidth: 1.5,
      borderColor: colors.warning,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 14,
      position: 'relative',
    },
    modalIconWrapperLocked: {
      borderColor: colors.border,
      opacity: 0.5,
    },
    modalIcon: {
      fontSize: 44,
    },
    modalLockBadge: {
      position: 'absolute',
      bottom: -6,
      right: -6,
      backgroundColor: colors.cardElevated,
      borderRadius: 10,
      padding: 3,
    },
    modalName: {
      fontSize: 20,
      fontWeight: '700',
      color: colors.text,
      textAlign: 'center',
      marginBottom: 6,
    },
    modalDesc: {
      fontSize: 14,
      color: colors.textMuted,
      textAlign: 'center',
      lineHeight: 20,
      marginBottom: 16,
    },
    statusBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: radius.pill,
      paddingHorizontal: 16,
      paddingVertical: 6,
      marginBottom: 16,
    },
    statusBadgeIcon: {
      marginRight: 6,
    },
    statusBadgeUnlocked: {
      backgroundColor: 'rgba(34,197,94,0.15)',
      borderWidth: 1,
      borderColor: colors.success,
    },
    statusBadgeLocked: {
      backgroundColor: 'rgba(136,136,136,0.15)',
      borderWidth: 1,
      borderColor: colors.border,
    },
    statusBadgeText: {
      fontSize: 13,
      fontWeight: '700',
    },
    statusBadgeTextUnlocked: {
      color: colors.success,
    },
    statusBadgeTextLocked: {
      color: colors.textMuted,
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
      color: colors.textMuted,
      fontWeight: '600',
    },
    modalProgressCount: {
      fontSize: 13,
      color: colors.text,
      fontWeight: '700',
    },
    // Share button — accent-filled primary action; label stays fixed white on
    // the accent fill in both themes (matches the app's accent-button convention).
    modalShareBtn: {
      width: '100%',
      flexDirection: 'row',
      backgroundColor: colors.accent,
      borderRadius: radius.md,
      paddingVertical: 14,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 4,
    },
    modalShareIcon: {
      marginRight: 8,
    },
    modalShareBtnText: {
      color: '#FFFFFF',
      fontSize: 15,
      fontWeight: '700',
    },
    modalCloseBtn: {
      width: '100%',
      backgroundColor: colors.cardElevated,
      borderRadius: radius.md,
      paddingVertical: 14,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      marginTop: 4,
    },
    modalCloseBtnText: {
      color: colors.textMuted,
      fontSize: 15,
      fontWeight: '600',
    },
  });
}

type Styles = ReturnType<typeof createStyles>;
