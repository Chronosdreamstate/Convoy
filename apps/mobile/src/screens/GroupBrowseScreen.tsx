import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
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
import * as ExpoLocation from 'expo-location';
import { apiClient } from '../services/apiClient';
import { haversineDistanceM } from '../services/DriveService';
import SkeletonCard, { SkeletonRow } from '../components/SkeletonLoader';

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
  distanceM?: number; // populated in Nearby mode
}

interface GroupEvent {
  id: string;
  title: string;
  scheduledAt: string; // ISO string
}

interface EventCountdown {
  label: string;
  urgent: boolean;
}

type FilterTab = 'All' | 'Nearby' | 'Active';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatGap(metres: number): string {
  if (metres < 1000) return `${metres} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
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
    return { label: `⏱ Starting in ${hours}h ${minutes}m`, urgent: true };
  }
  const date = new Date(scheduledAt);
  const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return { label: `📅 ${dayName} ${time}`, urgent: false };
}

// ---------------------------------------------------------------------------
// GroupCard
// ---------------------------------------------------------------------------

interface GroupCardProps {
  group: PublicGroup;
  onJoin: (id: string) => void;
  onView: (id: string) => void;
  joining: boolean;
  showDistance: boolean;
  eventCountdown?: EventCountdown | null;
}

function GroupCard({ group, onJoin, onView, joining, showDistance, eventCountdown }: GroupCardProps) {
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
        <Text style={styles.metaText}>👥 {group.memberCount} member{group.memberCount !== 1 ? 's' : ''}</Text>
        <Text style={styles.metaDot}>·</Text>
        <Text style={styles.metaText}>👑 {group.adminDisplayName}</Text>
      </View>

      <View style={styles.cardMeta}>
        <Text style={styles.metaText}>📏 {formatGap(group.gapThresholdM)} gap</Text>
        {group.isActive && (
          <>
            <Text style={styles.metaDot}>·</Text>
            <Text style={styles.activeText}>● Live</Text>
          </>
        )}
        {showDistance && group.distanceM !== undefined && (
          <>
            <Text style={styles.metaDot}>·</Text>
            <Text style={styles.distanceText}>📍 {formatDistance(group.distanceM)} away</Text>
          </>
        )}
      </View>

      {eventCountdown && (
        <View style={[styles.eventPill, eventCountdown.urgent && styles.eventPillUrgent]}>
          <Text style={[styles.eventPillText, eventCountdown.urgent && styles.eventPillTextUrgent]}>
            {eventCountdown.label}
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
  return (
    <TouchableOpacity
      style={styles.featCard}
      onPress={() => onView(group.id)}
      activeOpacity={0.8}
      accessibilityLabel={`Featured: ${group.name}, ${group.memberCount} members`}
      accessibilityRole="button"
    >
      <Text style={styles.featName} numberOfLines={2}>{group.name}</Text>
      <Text style={styles.featMeta}>👥 {group.memberCount}</Text>
      {eventCountdown && (
        <Text style={styles.featEvent} numberOfLines={1}>{eventCountdown.label}</Text>
      )}
      <TouchableOpacity
        style={[styles.featJoinBtn, joining && { opacity: 0.5 }]}
        onPress={(e) => { e.stopPropagation?.(); onJoin(group.id); }}
        disabled={joining}
        accessibilityRole="button"
        accessibilityLabel={`Join ${group.name}`}
      >
        <Text style={styles.featJoinText}>{joining ? '...' : 'Join →'}</Text>
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// GroupBrowseScreen
// ---------------------------------------------------------------------------

export default function GroupBrowseScreen() {
  const router = useRouter();
  const [groups, setGroups] = useState<PublicGroup[]>([]);
  const [featuredGroups, setFeaturedGroups] = useState<PublicGroup[]>([]);
  const [nearbyQuick, setNearbyQuick] = useState<PublicGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<FilterTab>('All');
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [eventCountdowns, setEventCountdowns] = useState<Record<string, EventCountdown | null>>({});
  const userCoordsRef = useRef<{ lat: number; lng: number } | null>(null);

  const FILTER_TABS: FilterTab[] = ['All', 'Nearby', 'Active'];

  const fetchGroups = useCallback(async (opts: {
    lat?: number;
    lng?: number;
    silent?: boolean;
  } = {}) => {
    if (!opts.silent) setLoading(true);
    try {
      const params: Record<string, unknown> = { accessType: 'open', limit: 40 };
      if (opts.lat !== undefined) params.lat = opts.lat;
      if (opts.lng !== undefined) params.lng = opts.lng;

      const res = await apiClient.get<{ groups: PublicGroup[] }>('/groups', { params });
      const fetched = res.data.groups ?? [];

      // If we have user coords, annotate each group with distance
      const coords = opts.lat !== undefined
        ? { lat: opts.lat, lng: opts.lng as number }
        : userCoordsRef.current;

      if (coords) {
        fetched.forEach((g) => {
          // Groups don't expose their own coords from the API yet — distance
          // will be populated when the API returns lat/lng. For now we leave
          // distanceM undefined so the badge is omitted gracefully.
        });
      }

      setGroups(fetched);
    } catch {
      Alert.alert('Error', 'Could not load public groups. Please try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const fetchFeatured = useCallback(async () => {
    try {
      const res = await apiClient.get<{ groups: PublicGroup[] }>('/groups/featured');
      setFeaturedGroups(res.data.groups ?? []);
    } catch {
      // silent — featured is a nice-to-have
    }
  }, []);

  // Initial load — parallel fetch of main groups + featured
  useEffect(() => {
    void fetchGroups();
    void fetchFeatured();
  }, [fetchGroups, fetchFeatured]);

  // Auto-fetch nearby quick list if location permission already granted (no request)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { status } = await ExpoLocation.getForegroundPermissionsAsync();
        if (status !== 'granted' || cancelled) return;
        const loc = await ExpoLocation.getCurrentPositionAsync({ accuracy: ExpoLocation.Accuracy.Balanced });
        if (cancelled) return;
        const coords = { lat: loc.coords.latitude, lng: loc.coords.longitude };
        userCoordsRef.current = coords;
        const res = await apiClient.get<{ groups: PublicGroup[] }>('/groups', {
          params: { accessType: 'open', nearby: true, lat: coords.lat, lng: coords.lng, limit: 5 },
        });
        if (!cancelled) setNearbyQuick(res.data.groups ?? []);
      } catch {
        // silent
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Fetch upcoming events for the first 5 visible groups
  useEffect(() => {
    if (groups.length === 0) return;
    let cancelled = false;
    const first5 = groups.slice(0, 5).map((g) => g.id);

    (async () => {
      const results = await Promise.all(
        first5.map(async (id) => {
          try {
            const res = await apiClient.get<{ events: GroupEvent[] }>(`/groups/${id}/events`);
            const events = res.data.events ?? [];
            const upcoming = events
              .map((e) => ({ id: e.id, countdown: formatCountdown(e.scheduledAt) }))
              .find((e) => e.countdown !== null);
            return { id, countdown: upcoming?.countdown ?? null };
          } catch {
            return { id, countdown: null };
          }
        }),
      );
      if (cancelled) return;
      const map: Record<string, EventCountdown | null> = {};
      results.forEach((r) => { map[r.id] = r.countdown; });
      setEventCountdowns(map);
    })();

    return () => { cancelled = true; };
  }, [groups]);

  // Handle Nearby filter activation
  useEffect(() => {
    if (activeFilter !== 'Nearby') {
      setLocationError(null);
      return;
    }

    // Already have coords — re-fetch immediately
    if (userCoordsRef.current) {
      void fetchGroups(userCoordsRef.current);
      return;
    }

    let cancelled = false;
    setLocating(true);
    setLocationError(null);

    (async () => {
      try {
        const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
        if (cancelled) return;

        if (status !== 'granted') {
          setLocationError('Location access needed for nearby groups.');
          setLocating(false);
          return;
        }

        const loc = await ExpoLocation.getCurrentPositionAsync({
          accuracy: ExpoLocation.Accuracy.Balanced,
        });
        if (cancelled) return;

        const coords = { lat: loc.coords.latitude, lng: loc.coords.longitude };
        userCoordsRef.current = coords;
        await fetchGroups(coords);
      } catch {
        if (!cancelled) setLocationError('Could not get your location. Please try again.');
      } finally {
        if (!cancelled) setLocating(false);
      }
    })();

    return () => { cancelled = true; };
  }, [activeFilter, fetchGroups]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    if (activeFilter === 'Nearby' && userCoordsRef.current) {
      void fetchGroups({ ...userCoordsRef.current, silent: true });
    } else {
      void fetchGroups({ silent: true });
    }
  }, [activeFilter, fetchGroups]);

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
      await apiClient.post(`/groups/${groupId}/join`);
      router.back();
    } catch {
      Alert.alert('Could not join', 'This group may be full or no longer available.');
    } finally {
      setJoiningId(null);
    }
  }, [router]);

  const isNearby = activeFilter === 'Nearby';

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Go back">
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Browse Groups</Text>
        <View style={styles.backButton} />
      </View>

      {/* Search bar */}
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            style={styles.searchInput}
            placeholder="Search groups..."
            placeholderTextColor="#555555"
            value={search}
            onChangeText={setSearch}
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Search groups"
          />
          {search.length > 0 && (
            <TouchableOpacity onPress={() => setSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button" accessibilityLabel="Clear search">
              <Text style={styles.clearIcon}>✕</Text>
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
              {tab === 'Nearby' ? '📍 Nearby' : tab}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Nearby status row */}
      {isNearby && (locating || locationError) && (
        <View style={styles.locationStatus}>
          {locating ? (
            <>
              <ActivityIndicator size="small" color="#DC143C" style={{ marginRight: 8 }} />
              <Text style={styles.locationStatusText}>Getting your location...</Text>
            </>
          ) : locationError ? (
            <>
              <Text style={styles.locationErrorText}>📍 {locationError}</Text>
              <TouchableOpacity
                onPress={() => void Linking.openSettings()}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel="Open location settings"
              >
                <Text style={styles.locationSettingsLink}> Open Settings</Text>
              </TouchableOpacity>
            </>
          ) : null}
        </View>
      )}

      {/* Content */}
      {loading && !refreshing ? (
        <View style={styles.skeletonList}>
          {[0, 1, 2, 3].map((i) => <SkeletonCard key={i} />)}
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <GroupCard
              group={item}
              onJoin={handleJoin}
              onView={(id) => router.push(`/group/${id}` as never)}
              joining={joiningId === item.id}
              showDistance={isNearby}
              eventCountdown={eventCountdowns[item.id]}
            />
          )}
          contentContainerStyle={filtered.length === 0 ? styles.emptyContainer : styles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyEmoji}>{locationError ? '📍' : '🔍'}</Text>
              <Text style={styles.emptyTitle}>
                {locationError ? 'Location Unavailable' : 'No public groups found'}
              </Text>
              <Text style={styles.emptySubtitle}>
                {locationError
                  ? locationError
                  : search.length > 0
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
              tintColor="#DC143C"
              colors={['#DC143C']}
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
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
    color: '#DC143C',
    fontSize: 17,
    fontWeight: '600',
  },
  headerTitle: {
    color: '#FFFFFF',
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
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  searchIcon: {
    fontSize: 16,
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 15,
    padding: 0,
  },
  clearIcon: {
    color: '#555555',
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
    backgroundColor: '#1C1C1C',
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  filterPillActive: {
    backgroundColor: '#DC143C',
    borderColor: '#DC143C',
  },
  filterPillText: {
    color: '#888888',
    fontSize: 13,
    fontWeight: '600',
  },
  filterPillTextActive: {
    color: '#FFFFFF',
  },
  locationStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  locationStatusText: {
    color: '#888888',
    fontSize: 13,
  },
  locationErrorText: {
    color: '#888888',
    fontSize: 13,
    flex: 1,
  },
  locationSettingsLink: {
    color: '#DC143C',
    fontSize: 13,
    fontWeight: '600',
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
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
  },
  emptySubtitle: {
    color: '#888888',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  // Card
  card: {
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  groupName: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    flex: 1,
    marginRight: 8,
  },
  openBadge: {
    backgroundColor: 'rgba(34, 197, 94, 0.15)',
    borderWidth: 1,
    borderColor: '#22C55E',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  openBadgeText: {
    color: '#22C55E',
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
    color: '#888888',
    fontSize: 13,
  },
  metaDot: {
    color: '#444444',
    fontSize: 13,
    marginHorizontal: 6,
  },
  activeText: {
    color: '#22C55E',
    fontSize: 13,
    fontWeight: '600',
  },
  distanceText: {
    color: '#DC143C',
    fontSize: 13,
    fontWeight: '600',
  },
  eventPill: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.35)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginTop: 8,
  },
  eventPillUrgent: {
    backgroundColor: 'rgba(245, 158, 11, 0.22)',
    borderColor: '#F59E0B',
  },
  eventPillText: {
    color: '#F59E0B',
    fontSize: 12,
    fontWeight: '600',
  },
  eventPillTextUrgent: {
    color: '#F59E0B',
  },
  cardActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  joinButton: {
    flex: 1,
    backgroundColor: '#DC143C',
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
    borderColor: '#2A2A2A',
  },
  viewButtonText: {
    color: '#888888',
    fontSize: 15,
    fontWeight: '600',
  },
});
