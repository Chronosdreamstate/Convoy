import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { apiClient } from '../services/apiClient';
import { MotionCapNotice, useMotionCappedData } from '../components/MotionAwareList';
import SkeletonCard from '../components/SkeletonLoader';
import { NetworkError } from '../components/NetworkError';
import { useTheme, withAlpha, ThemeColors } from '../theme';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PublicGroup {
  id: string;
  name: string;
  adminDisplayName: string;
  memberCount: number;
  gapThresholdM: number;
  accessType: 'open' | 'invite_only';
  isActive: boolean;
  // Soonest upcoming event, joined in by GET /groups and /groups/featured —
  // the canonical source for the countdown pill (no per-group events fetch).
  nextEvent?: { title: string; scheduledFor: string } | null;
}

interface EventCountdown {
  label: string;
  urgent: boolean;
}

type FilterTab = 'All' | 'Active';

// Vehicle filter chip icons — rendered alongside the text label. Chips with no
// clean vector-icon equivalent (JDM/Muscle are cultural/regional labels, not
// vehicle shapes) keep their flag emoji as decorative label content.
const VEHICLE_FILTERS: Array<{ key: string | null; label: string; icon: keyof typeof MaterialCommunityIcons.glyphMap | null }> = [
  { key: null,          label: 'All',     icon: null },
  { key: 'sports_car',  label: 'Sports',  icon: 'car-sports' },
  { key: 'truck',       label: 'Trucks',  icon: 'car-pickup' },
  { key: 'suv',         label: 'SUVs',    icon: 'car-estate' },
  { key: 'jdm',         label: '🎌 JDM',    icon: null },
  { key: 'muscle',      label: '🇺🇸 Muscle', icon: null },
  { key: 'ev',          label: 'EV',      icon: 'car-electric' },
  { key: 'track_car',   label: 'Track',   icon: 'flag-checkered' },
];
type VehicleFilter = typeof VEHICLE_FILTERS[number]['key'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatGap(metres: number): string {
  if (metres < 1000) return `${metres} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

function formatCountdown(scheduledAt: string): EventCountdown | null {
  const diff = new Date(scheduledAt).getTime() - Date.now();
  if (diff <= 0) return null;
  const days = diff / (1000 * 60 * 60 * 24);
  if (days > 7) return null;
  if (diff < 1000 * 60 * 60 * 24) {
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return { label: `Starting in ${hours}h ${minutes}m`, urgent: true };
  }
  const date = new Date(scheduledAt);
  const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return { label: `${dayName} ${time}`, urgent: false };
}

/** Countdown pill data from a group's server-joined next event (if any). */
function countdownFor(group: PublicGroup): EventCountdown | null {
  return group.nextEvent ? formatCountdown(group.nextEvent.scheduledFor) : null;
}

// ---------------------------------------------------------------------------
// GroupCard
// ---------------------------------------------------------------------------

interface GroupCardProps {
  group: PublicGroup;
  onJoin: (id: string) => void;
  onView: (id: string) => void;
  joining: boolean;
  eventCountdown?: EventCountdown | null;
}

function GroupCard({ group, onJoin, onView, joining, eventCountdown }: GroupCardProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => onView(group.id)}
      activeOpacity={0.8}
      accessibilityLabel={`${group.name}, ${group.memberCount} members`}
      accessibilityRole="button"
    >
      <View style={styles.cardHeader}>
        <Text style={styles.groupName} numberOfLines={1}>{group.name}</Text>
        <View style={styles.openBadge}>
          <Text style={styles.openBadgeText}>OPEN</Text>
        </View>
      </View>

      <View style={styles.cardMeta}>
        <Text style={styles.metaText}>
          <Ionicons name="people-outline" size={12} color={colors.textMuted} /> {group.memberCount} member{group.memberCount !== 1 ? 's' : ''}
        </Text>
        <Text style={styles.metaDot}>·</Text>
        <Text style={styles.metaText}>
          <MaterialCommunityIcons name="crown" size={12} color={colors.textMuted} /> {group.adminDisplayName}
        </Text>
      </View>

      <View style={styles.cardMeta}>
        <Text style={styles.metaText}>
          <MaterialCommunityIcons name="ruler" size={12} color={colors.textMuted} /> {formatGap(group.gapThresholdM)} gap
        </Text>
        {group.isActive && (
          <>
            <Text style={styles.metaDot}>·</Text>
            <Text style={styles.activeText}>● Live</Text>
          </>
        )}
      </View>

      {eventCountdown && (
        <View style={[styles.eventPill, eventCountdown.urgent && styles.eventPillUrgent]}>
          <Text style={[styles.eventPillText, eventCountdown.urgent && styles.eventPillTextUrgent]}>
            <Ionicons name={eventCountdown.urgent ? 'timer-outline' : 'calendar-outline'} size={11} color={colors.warning} /> {eventCountdown.label}
          </Text>
        </View>
      )}

      <View style={styles.cardActions}>
        <TouchableOpacity
          style={[styles.joinButton, joining && styles.joinButtonDisabled]}
          onPress={(e) => { e.stopPropagation?.(); onJoin(group.id); }}
          disabled={joining}
          accessibilityRole="button"
          accessibilityLabel={`Join ${group.name}`}
        >
          {joining ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={styles.joinButtonText}>Join</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.viewButton}
          onPress={() => onView(group.id)}
          accessibilityRole="button"
          accessibilityLabel={`View ${group.name} details`}
        >
          <Text style={styles.viewButtonText}>Details ›</Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// FeaturedCard — compact 140px card for horizontal featured scroll
// ---------------------------------------------------------------------------

interface FeaturedCardProps {
  group: PublicGroup;
  onJoin: (id: string) => void;
  onView: (id: string) => void;
  joining: boolean;
  eventCountdown?: EventCountdown | null;
}

function FeaturedCard({ group, onJoin, onView, joining, eventCountdown }: FeaturedCardProps) {
  const { colors } = useTheme();
  const browseStyles = useMemo(() => createBrowseStyles(colors), [colors]);
  return (
    <TouchableOpacity
      style={browseStyles.featCard}
      onPress={() => onView(group.id)}
      activeOpacity={0.8}
      accessibilityLabel={`Featured: ${group.name}, ${group.memberCount} members`}
      accessibilityRole="button"
    >
      <Text style={browseStyles.featName} numberOfLines={2}>{group.name}</Text>
      <Text style={browseStyles.featMeta}>
        <Ionicons name="people-outline" size={11} color={colors.textMuted} /> {group.memberCount}
      </Text>
      {eventCountdown && (
        <Text style={browseStyles.featEvent} numberOfLines={1}>
          <Ionicons name={eventCountdown.urgent ? 'timer-outline' : 'calendar-outline'} size={10} color={colors.warning} /> {eventCountdown.label}
        </Text>
      )}
      <TouchableOpacity
        style={[browseStyles.featJoinBtn, joining && { opacity: 0.5 }]}
        onPress={(e) => { e.stopPropagation?.(); onJoin(group.id); }}
        disabled={joining}
        accessibilityRole="button"
        accessibilityLabel={`Join ${group.name}`}
        accessibilityState={{ disabled: joining, busy: joining }}
      >
        {joining ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : (
          <Text style={browseStyles.featJoinText}>Join →</Text>
        )}
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// GroupBrowseScreen
// ---------------------------------------------------------------------------

export default function GroupBrowseScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const browseStyles = useMemo(() => createBrowseStyles(colors), [colors]);
  const router = useRouter();
  const [groups, setGroups] = useState<PublicGroup[]>([]);
  const [featuredGroups, setFeaturedGroups] = useState<PublicGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<FilterTab>('All');
  const [vehicleFilter, setVehicleFilter] = useState<VehicleFilter>(null);
  const [joiningId, setJoiningId] = useState<string | null>(null);

  const FILTER_TABS: FilterTab[] = ['All', 'Active'];

  const fetchGroups = useCallback(async (opts: {
    silent?: boolean;
    vehicleType?: VehicleFilter;
    q?: string;
  } = {}) => {
    if (!opts.silent) setLoading(true);
    setFetchError(null);
    try {
      const params: Record<string, unknown> = { accessType: 'open', limit: 40 };
      const vf = opts.vehicleType !== undefined ? opts.vehicleType : vehicleFilter;
      if (vf) params.vehicleType = vf;
      // Server-side name search (API supports `q`). Without this, a group whose
      // name matches but which falls outside the first 40 rows is unsearchable
      // and unjoinable — client-side filtering alone only sees loaded rows.
      const q = opts.q?.trim();
      if (q) params.q = q;

      const res = await apiClient.get<{ groups: PublicGroup[] }>('/api/v1/groups', { params });
      setGroups(res.data.groups ?? []);
    } catch {
      setFetchError('Could not load groups. Check your connection.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [vehicleFilter]);

  const fetchFeatured = useCallback(async () => {
    try {
      const res = await apiClient.get<{ groups: PublicGroup[] }>('/api/v1/groups/featured');
      setFeaturedGroups(res.data.groups ?? []);
    } catch {
      // silent — featured is a nice-to-have
    }
  }, []);

  // Re-fetch when vehicleFilter changes
  useEffect(() => {
    void fetchGroups();
  }, [vehicleFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Initial load — parallel fetch of main groups + featured
  useEffect(() => {
    void fetchGroups();
    void fetchFeatured();
  }, [fetchGroups, fetchFeatured]);

  // Debounced server-side search so results aren't limited to the loaded page.
  // Skips the initial mount (the load effects already fetched with no query).
  const searchInitRef = useRef(false);
  useEffect(() => {
    if (!searchInitRef.current) { searchInitRef.current = true; return; }
    const handle = setTimeout(() => {
      void fetchGroups({ q: search, silent: true });
    }, 350);
    return () => clearTimeout(handle);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void fetchGroups({ silent: true });
  }, [fetchGroups]);

  const filtered = groups
    .filter((g) => {
      const matchesSearch = g.name.toLowerCase().includes(search.toLowerCase());
      if (!matchesSearch) return false;
      if (activeFilter === 'Active') return g.isActive;
      return true;
    });

  const handleJoin = useCallback(async (groupId: string) => {
    setJoiningId(groupId);
    try {
      await apiClient.post(`/api/v1/groups/${groupId}/members`, {});
      // Enter the convoy after joining (matches GroupDetailScreen). `back()`
      // dropped the user on the stale browse list without entering the group.
      router.replace('/(tabs)/convoy');
    } catch (e: unknown) {
      // 409 = already a member — that's a success for "enter this convoy".
      if ((e as { status?: number }).status === 409) {
        router.replace('/(tabs)/convoy');
      } else {
        Alert.alert('Could not join', 'This group may be full or no longer available.');
      }
    } finally {
      setJoiningId(null);
    }
  }, [router]);

  // Req 33 — while the vehicle is in motion, cap every scrollable list on this
  // screen to 4 rows/cards (a passenger browsing convoys to join mid-drive is
  // a normal use of this screen). The main results list gets the standard
  // "pull over to see more" footer; the horizontal Featured carousel is capped
  // the same way with the notice rendered under it. Section render conditions
  // (featured >= 3) and the events fetch keep reading the full arrays so
  // nothing is lost while capped.
  const { data: visibleGroups, hiddenCount: hiddenGroupCount } = useMotionCappedData(filtered);
  const { data: visibleFeatured, hiddenCount: hiddenFeaturedCount } = useMotionCappedData(featuredGroups);

  const renderGroupItem = useCallback(
    ({ item }: { item: PublicGroup }) => (
      <GroupCard
        group={item}
        onJoin={handleJoin}
        onView={(id) => router.push(`/group/${id}` as never)}
        joining={joiningId === item.id}
        eventCountdown={countdownFor(item)}
      />
    ),
    [handleJoin, router, joiningId],
  );

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Go back">
          <Text style={styles.backText}>
            <Ionicons name="chevron-back" size={16} color={colors.accent} /> Back
          </Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Browse Groups</Text>
        <View style={styles.backButton} />
      </View>

      {/* Featured Groups horizontal scroll */}
      {featuredGroups.length >= 3 && (
        <View style={browseStyles.featuredSection}>
          <Text style={browseStyles.featuredTitle}>
            <Ionicons name="flame-outline" size={14} color={colors.text} /> Featured Groups
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={browseStyles.featuredContent}
          >
            {visibleFeatured.map((group) => (
              <FeaturedCard
                key={group.id}
                group={group}
                onJoin={handleJoin}
                onView={(id) => router.push(`/group/${id}` as never)}
                joining={joiningId === group.id}
                eventCountdown={countdownFor(group)}
              />
            ))}
          </ScrollView>
          <MotionCapNotice hiddenCount={hiddenFeaturedCount} />
        </View>
      )}

      {/* Search bar */}
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={16} color={colors.textMuted} style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search groups..."
            placeholderTextColor={colors.textSubtle}
            value={search}
            onChangeText={setSearch}
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Search groups"
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel="Clear search">
              <Ionicons name="close" size={14} color={colors.textSubtle} style={styles.clearIcon} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Filter pills */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterRow}
        contentContainerStyle={styles.filterContent}
      >
        {FILTER_TABS.map((tab) => (
          <TouchableOpacity
            key={tab}
            style={[styles.filterPill, activeFilter === tab && styles.filterPillActive]}
            onPress={() => setActiveFilter(tab)}
            accessibilityRole="button"
            accessibilityLabel={tab}
            accessibilityState={{ selected: activeFilter === tab }}
          >
            <Text style={[styles.filterPillText, activeFilter === tab && styles.filterPillTextActive]}>
              {tab}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Vehicle type filter chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterRow}
        contentContainerStyle={styles.filterContent}
      >
        {VEHICLE_FILTERS.map((vf) => (
          <TouchableOpacity
            key={String(vf.key)}
            style={[styles.filterPill, vehicleFilter === vf.key && styles.filterPillActive]}
            onPress={() => setVehicleFilter(vf.key)}
            accessibilityRole="button"
            accessibilityLabel={vf.label}
            accessibilityState={{ selected: vehicleFilter === vf.key }}
          >
            <Text style={[styles.filterPillText, vehicleFilter === vf.key && styles.filterPillTextActive]}>
              {vf.icon && (
                <MaterialCommunityIcons
                  name={vf.icon}
                  size={12}
                  color={vehicleFilter === vf.key ? '#FFFFFF' : colors.textMuted}
                />
              )}
              {vf.icon ? ` ${vf.label}` : vf.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Content */}
      {loading && !refreshing ? (
        <View style={styles.skeletonList}>
          {[0, 1, 2, 3].map((i) => <SkeletonCard key={i} />)}
        </View>
      ) : fetchError ? (
        <NetworkError onRetry={() => fetchGroups()} message={fetchError} />
      ) : (
        <FlatList
          data={visibleGroups}
          keyExtractor={(item) => item.id}
          renderItem={renderGroupItem}
          contentContainerStyle={filtered.length === 0 ? styles.emptyContainer : styles.listContent}
          ListFooterComponent={<MotionCapNotice hiddenCount={hiddenGroupCount} />}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons
                name="search-outline"
                size={52}
                color={colors.textMuted}
                style={styles.emptyEmoji}
              />
              <Text style={styles.emptyTitle}>No public groups found</Text>
              <Text style={styles.emptySubtitle}>
                {search.length > 0
                  ? 'Try a different search term'
                  : 'Be the first to create a public group'}
              </Text>
            </View>
          }
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
    </SafeAreaView>
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  backButton: {
    width: 60,
  },
  backText: {
    color: colors.accent,
    fontSize: 17,
    fontWeight: '600',
  },
  headerTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  searchRow: {
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  searchIcon: {
    fontSize: 16,
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    padding: 0,
  },
  clearIcon: {
    color: colors.textSubtle,
    fontSize: 14,
    paddingLeft: 8,
  },
  filterRow: {
    flexGrow: 0,
    marginBottom: 4,
  },
  filterContent: {
    paddingHorizontal: 16,
    gap: 8,
    flexDirection: 'row',
  },
  filterPill: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  filterPillActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  filterPillText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  filterPillTextActive: {
    color: '#FFFFFF',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 24,
    gap: 12,
  },
  emptyContainer: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skeletonList: {
    paddingHorizontal: 16,
    paddingTop: 8,
    gap: 12,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    paddingTop: 80,
  },
  emptyEmoji: {
    fontSize: 52,
    marginBottom: 16,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
  },
  emptySubtitle: {
    color: colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  // Card
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  groupName: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
    flex: 1,
    marginRight: 8,
  },
  openBadge: {
    backgroundColor: withAlpha(colors.success, 0.15),
    borderWidth: 1,
    borderColor: colors.success,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  openBadgeText: {
    color: colors.success,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  cardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
    flexWrap: 'wrap',
  },
  metaText: {
    color: colors.textMuted,
    fontSize: 13,
  },
  metaDot: {
    color: colors.textSubtle,
    fontSize: 13,
    marginHorizontal: 6,
  },
  activeText: {
    color: colors.success,
    fontSize: 13,
    fontWeight: '600',
  },
  eventPill: {
    alignSelf: 'flex-start',
    backgroundColor: withAlpha(colors.warning, 0.12),
    borderWidth: 1,
    borderColor: withAlpha(colors.warning, 0.35),
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginTop: 8,
  },
  eventPillUrgent: {
    backgroundColor: withAlpha(colors.warning, 0.22),
    borderColor: colors.warning,
  },
  eventPillText: {
    color: colors.warning,
    fontSize: 12,
    fontWeight: '600',
  },
  eventPillTextUrgent: {
    color: colors.warning,
  },
  cardActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  joinButton: {
    flex: 1,
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  joinButtonDisabled: {
    opacity: 0.6,
  },
  joinButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  viewButton: {
    flex: 1,
    backgroundColor: 'transparent',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.border,
  },
  viewButtonText: {
    color: colors.textMuted,
    fontSize: 15,
    fontWeight: '600',
  },
  });
}

function createBrowseStyles(colors: ThemeColors) {
  return StyleSheet.create({
  // Featured section
  featuredSection: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  featuredTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 10,
  },
  featuredContent: {
    gap: 10,
    paddingRight: 4,
  },
  featCard: {
    width: 140,
    minHeight: 110,
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
  },
  featName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 4,
    lineHeight: 18,
  },
  featMeta: {
    color: colors.textMuted,
    fontSize: 12,
    marginBottom: 4,
  },
  featEvent: {
    color: colors.warning,
    fontSize: 11,
    marginBottom: 6,
  },
  featJoinBtn: {
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 6,
    paddingVertical: 5,
    alignItems: 'center',
    marginTop: 4,
  },
  featJoinText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  });
}
