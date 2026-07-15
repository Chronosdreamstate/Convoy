/**
 * NearbyScreen — opt-in nearby-stranger discovery.
 *
 * Shows other CORTEGE users near the current user who have also opted in via
 * Settings > Nearby > "Visible to nearby drivers". Only ever displays an
 * *approximate* distance — the backend already snaps coordinates to a ~110m
 * grid and buckets distance to the nearest 100m, so this screen never
 * requests, infers, or displays anyone's exact location.
 *
 * Three distinct states are handled explicitly (never a blank list):
 *  1. The current user hasn't opted in yet — nudge them to Settings. This is
 *     the true opt-in gate: the nearby list is never fetched/shown unless
 *     visibleToNearby is on for the current user.
 *  2. Location permission is missing/denied — prompt to enable it.
 *  3. Opted in with location, but no one else nearby is visible right now.
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Linking,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import * as ExpoLocation from 'expo-location';
import { apiClient } from '../services/apiClient';
import { MotionCapNotice, useMotionCappedData } from '../components/MotionAwareList';
import { SkeletonRow } from '../components/SkeletonLoader';
import { useSettingsStore } from '../stores/settingsStore';
import { ThemeColors, useTheme } from '../theme';

// ---------------------------------------------------------------------------
// Types — mirrors the #71 backend contract (GET /api/v1/nearby, POST
// /api/v1/nearby/dm). Defined locally since apps/api isn't merged yet.
// ---------------------------------------------------------------------------

interface NearbyUser {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  approxLat: number;
  approxLng: number;
  distanceM: number;
}

interface NearbyResponse {
  users: NearbyUser[];
  radiusM: number;
}

// Avatar colors — deterministic per name. Intentionally a fixed decorative
// palette (not theme chrome) so a given user's initials bubble looks the
// same regardless of light/dark mode.
const AVATAR_COLORS = ['#DC143C', '#6366F1', '#0EA5E9', '#10B981', '#F59E0B', '#EC4899', '#8B5CF6', '#14B8A6'];
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}

/** Formats a distance in metres, respecting the user's km/miles preference (Settings > Map > Distance Units). */
function formatDistance(metres: number, unit: 'km' | 'miles'): string {
  if (unit === 'miles') {
    const miles = metres / 1609.344;
    if (miles < 0.1) return `${Math.round(metres * 3.28084)} ft`;
    return `${miles.toFixed(1)} mi`;
  }
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

type LoadState = 'loading' | 'opted-out' | 'needs-location' | 'location-error' | 'ready';

export default function NearbyScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const distanceUnit = useSettingsStore((s) => s.distanceUnit);
  const [state, setState] = useState<LoadState>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [users, setUsers] = useState<NearbyUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  // Separate from `error` (list load/refresh failures, which get a full
  // empty-state-with-retry or a header banner) — a chat-start failure
  // doesn't call for a "reload the list" retry, just a small non-blocking note.
  const [chatError, setChatError] = useState<string | null>(null);

  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setState('loading');
    setError(null);
    setLocationError(null);
    try {
      // Step 1: confirm the current user has opted in. This is the true
      // opt-in gate — the nearby list is never requested unless this is on.
      const settingsRes = await apiClient.get<{ visibleToNearby?: boolean }>('/api/v1/settings');
      if (!(settingsRes.data.visibleToNearby ?? false)) {
        setState('opted-out');
        setUsers([]);
        return;
      }

      // Step 2: get the device's current (approximate-use) location. Reuses
      // the same foreground-permission + getCurrentPositionAsync pattern as
      // GroupBrowseScreen's "Nearby" filter.
      const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setState('needs-location');
        setLocationError('Location access needed to find nearby drivers.');
        return;
      }
      const loc = await ExpoLocation.getCurrentPositionAsync({ accuracy: ExpoLocation.Accuracy.Balanced });

      // Step 3: fetch nearby opted-in users. The server already snaps
      // coordinates and buckets distance — no client-side fuzzing needed.
      const nearbyRes = await apiClient.get<NearbyResponse>('/api/v1/nearby', {
        params: { lat: loc.coords.latitude, lng: loc.coords.longitude },
      });
      setUsers(nearbyRes.data.users ?? []);
      setState('ready');
    } catch {
      setError('Could not load nearby drivers. Please try again.');
      setState('ready');
    }
  }, []);

  // Re-run on every focus (not just mount) — the opted-out and
  // needs-location empty states both send the user to the device Settings
  // app via a button, and this screen must re-check when they come back
  // instead of showing a stale prompt for a state that no longer applies.
  useFocusEffect(
    useCallback(() => {
      void load({ silent: true });
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load({ silent: true });
    setRefreshing(false);
  }, [load]);

  const handleChat = useCallback(async (target: NearbyUser) => {
    if (connectingId) return;
    setConnectingId(target.userId);
    setChatError(null);
    try {
      const res = await apiClient.post<{ groupId: string }>('/api/v1/nearby/dm', { userId: target.userId });
      (router.push as (href: { pathname: string; params?: Record<string, string> }) => void)({
        pathname: '/group-chat',
        params: { groupId: res.data.groupId },
      });
    } catch {
      setChatError('Could not start a chat right now. Please try again.');
    } finally {
      setConnectingId(null);
    }
  }, [router, connectingId]);

  const renderItem = useCallback(({ item }: { item: NearbyUser }) => {
    const isConnecting = connectingId === item.userId;
    return (
      <View style={styles.card}>
        <View style={[styles.avatar, { backgroundColor: avatarColor(item.displayName) }]}>
          {item.avatarUrl ? (
            <Image
              source={{ uri: item.avatarUrl }}
              style={styles.avatarImage}
              accessibilityLabel={`${item.displayName}'s avatar`}
            />
          ) : (
            <Text style={styles.avatarText}>{initials(item.displayName)}</Text>
          )}
        </View>
        <View style={styles.cardInfo}>
          <Text style={styles.cardName} numberOfLines={1}>{item.displayName}</Text>
          <View style={styles.cardSubRow}>
            <Ionicons name="location-outline" size={12} color={colors.textMuted} />
            <Text style={styles.cardSub}>{formatDistance(item.distanceM, distanceUnit)} away</Text>
          </View>
        </View>
        <TouchableOpacity
          style={styles.chatBtn}
          onPress={() => { void handleChat(item); }}
          disabled={isConnecting}
          accessibilityRole="button"
          accessibilityLabel={`Chat with ${item.displayName}`}
          accessibilityState={{ disabled: isConnecting }}
        >
          {isConnecting ? (
            <ActivityIndicator color={colors.accent} size="small" />
          ) : (
            <>
              <Ionicons name="chatbubble-outline" size={13} color={colors.accent} style={styles.chatBtnIcon} />
              <Text style={styles.chatBtnText}>Chat</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    );
  }, [connectingId, handleChat, distanceUnit, colors, styles]);

  const isLoading = state === 'loading';
  const isOptedOut = state === 'opted-out';
  const needsLocation = state === 'needs-location';

  // Req 33 — while the vehicle is in motion, cap the nearby-drivers list to 4
  // rows with a "pull over to see more" notice. This screen is squarely
  // reachable mid-drive (spotting other drivers around you is its whole
  // point), so the cap must apply. Full list returns the moment the car parks.
  const { data: visibleUsers, hiddenCount } = useMotionCappedData(users);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="chevron-back" size={22} color={colors.accent} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Nearby</Text>
        <View style={styles.backButton} />
      </View>

      {isLoading ? (
        <View style={styles.skeletonWrap}>{[0, 1, 2].map((i) => <SkeletonRow key={i} />)}</View>
      ) : isOptedOut ? (
        <View style={styles.empty}>
          <Ionicons name="radio-outline" size={44} color={colors.textMuted} style={styles.emptyIcon} />
          <Text style={styles.emptyTitle}>See who's driving nearby</Text>
          <Text style={styles.emptySub}>
            Turn on "Visible to nearby drivers" in Settings to see other opted-in
            drivers around you and start a chat. Your exact location is never
            shared — only your approximate distance, and only while the toggle
            is on.
          </Text>
          <TouchableOpacity
            style={styles.settingsBtn}
            onPress={() => router.push('/(tabs)/settings' as never)}
            accessibilityRole="button"
            accessibilityLabel="Go to Settings"
          >
            <Text style={styles.settingsBtnText}>Go to Settings</Text>
          </TouchableOpacity>
        </View>
      ) : needsLocation ? (
        <View style={styles.empty}>
          <Ionicons name="location-outline" size={44} color={colors.textMuted} style={styles.emptyIcon} />
          <Text style={styles.emptyTitle}>Location needed</Text>
          <Text style={styles.emptySub}>
            {locationError ?? 'Enable location access to see drivers nearby.'}
          </Text>
          <TouchableOpacity
            style={styles.settingsBtn}
            onPress={() => void Linking.openSettings()}
            accessibilityRole="button"
            accessibilityLabel="Open location settings"
          >
            <Text style={styles.settingsBtnText}>Open Settings</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={visibleUsers}
          keyExtractor={(u) => u.userId}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          ListFooterComponent={<MotionCapNotice hiddenCount={hiddenCount} />}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { void onRefresh(); }} tintColor={colors.accent} colors={[colors.accent]} />
          }
          ListHeaderComponent={
            (error && users.length > 0) || chatError ? (
              <View style={styles.bannerStack}>
                {error && users.length > 0 && (
                  <View style={styles.errorBanner}>
                    <Text style={styles.errorBannerTxt}>{error}</Text>
                    <TouchableOpacity
                      onPress={() => { void load(); }}
                      accessibilityRole="button"
                      accessibilityLabel="Retry loading nearby drivers"
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Text style={styles.errorRetryText}>Retry</Text>
                    </TouchableOpacity>
                  </View>
                )}
                {chatError && <Text style={styles.errorTxt}>{chatError}</Text>}
              </View>
            ) : null
          }
          ListEmptyComponent={
            error ? (
              <View style={styles.empty}>
                <Ionicons name="alert-circle-outline" size={44} color={colors.textMuted} style={styles.emptyIcon} />
                <Text style={styles.emptyTitle}>Couldn't load nearby drivers</Text>
                <Text style={styles.emptySub}>{error}</Text>
                <TouchableOpacity
                  style={styles.settingsBtn}
                  onPress={() => { void load(); }}
                  accessibilityRole="button"
                  accessibilityLabel="Try again"
                >
                  <Text style={styles.settingsBtnText}>Try Again</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.empty}>
                <Ionicons name="moon-outline" size={44} color={colors.textMuted} style={styles.emptyIcon} />
                <Text style={styles.emptyTitle}>No one nearby right now</Text>
                <Text style={styles.emptySub}>
                  Nobody who's opted in to Nearby is around at the moment. Check
                  back later — this refreshes when you pull down.
                </Text>
              </View>
            )
          }
        />
      )}
    </SafeAreaView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 12,
    },
    backButton: { width: 70, flexDirection: 'row', alignItems: 'center', minHeight: 44 },
    backText: { color: colors.accent, fontSize: 17, fontWeight: '600', marginLeft: -2 },
    headerTitle: { color: colors.text, fontSize: 17, fontWeight: '700', letterSpacing: 0.3 },

    skeletonWrap: { paddingHorizontal: 16, paddingTop: 12, gap: 12 },

    list: { padding: 16, gap: 10 },
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: colors.card,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 14,
      paddingVertical: 12,
      minHeight: 72,
    },
    avatar: {
      width: 44, height: 44, borderRadius: 22,
      alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    },
    avatarImage: { width: 44, height: 44, borderRadius: 22 },
    avatarText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
    cardInfo: { flex: 1, marginRight: 8 },
    cardName: { fontSize: 15, fontWeight: '700', color: colors.text },
    cardSubRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
    cardSub: { fontSize: 12, color: colors.textMuted },

    chatBtn: {
      flexDirection: 'row', alignItems: 'center',
      borderWidth: 1, borderColor: colors.accent, borderRadius: 8,
      paddingHorizontal: 14, paddingVertical: 8, minWidth: 44, minHeight: 36,
      justifyContent: 'center',
    },
    chatBtnIcon: { marginRight: 5 },
    chatBtnText: { fontSize: 13, fontWeight: '700', color: colors.accent },

    empty: { alignItems: 'center', paddingTop: 72, paddingHorizontal: 32 },
    emptyIcon: { marginBottom: 14 },
    emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 8, textAlign: 'center' },
    emptySub: { fontSize: 14, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
    errorTxt: { color: colors.accent, fontSize: 13, marginBottom: 10, textAlign: 'center' },

    bannerStack: { gap: 8, marginBottom: 10 },
    errorBanner: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
      borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10,
    },
    errorBannerTxt: { flex: 1, color: colors.textMuted, fontSize: 13, marginRight: 10 },
    errorRetryText: { color: colors.accent, fontSize: 13, fontWeight: '700' },

    settingsBtn: {
      marginTop: 20, backgroundColor: colors.accent, borderRadius: 12,
      paddingHorizontal: 24, paddingVertical: 12, minHeight: 48,
      alignItems: 'center', justifyContent: 'center',
    },
    settingsBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  });
}
