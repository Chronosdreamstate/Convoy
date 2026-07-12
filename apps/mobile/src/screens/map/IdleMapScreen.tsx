import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ExpoLocation from 'expo-location';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Socket } from 'socket.io-client';
import { Ionicons, MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
import LocationPermissionPrescreen from '../../components/LocationPermissionPrescreen';
import { apiClient } from '../../services/apiClient';
import { authService } from '../../services/AuthService';
import { HapticService } from '../../services/HapticService';
import { WebSocketService } from '../../services/WebSocketService';
import { rallyService, SosPin, SOS_EMOJI } from '../../services/RallyService';
import { openMapsDirections } from '../../utils/openMapsDirections';
import { useAuthStore } from '../../stores/authStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useReduceMotion } from '../../hooks/useReduceMotion';
import { ThemeColors, useTheme } from '../../theme';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
const SOCKET_URL = API_URL.replace(/^http/, 'ws');

const DEFAULT_REGION = {
  latitude: 37.7749,
  longitude: -122.4194,
  latitudeDelta: 0.1,
  longitudeDelta: 0.1,
};

interface NearbyGroup {
  id: string;
  name: string;
  memberCount: number;
  lat?: number;
  lng?: number;
}

/**
 * A friend currently sharing their live location with the caller
 * (`shareLocationWithFriends` toggle in Settings), as returned by
 * `GET /api/v1/friends/locations`. Shape per the documented contract — parsed
 * defensively below since the backend for this is landing in parallel.
 */
interface FriendLocationPin {
  userId: string;
  lat: number;
  lng: number;
  displayName?: string;
  avatarUrl?: string | null;
  heading?: number;
  speedKph?: number;
  ts: number;
}

/** "3m ago" / "2h ago" style relative timestamp for a friend's shared-location fix. */
function formatLocTimeAgo(tsMs: number): string {
  const mins = Math.floor((Date.now() - tsMs) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function getGreeting(displayName: string): string {
  const firstName = displayName.split(' ')[0];
  const hour = new Date().getHours();
  if (hour < 12) return `Good morning, ${firstName} 👋`;
  if (hour < 17) return `Good afternoon, ${firstName} 👋`;
  return `Good evening, ${firstName} 👋`;
}

/**
 * Req 25.1 gates SOS to authenticated members. IdleMapScreen only mounts for
 * signed-in users (guests are routed to GuestMapScreen — see
 * app/(tabs)/map.tsx), but the auth store's user can still be momentarily
 * null (e.g. mid sign-out), so the SOS affordance gates on it defensively
 * rather than assuming. Exported for tests.
 */
export function canSendSos(user: { id: string } | null | undefined): boolean {
  return !!user;
}

/**
 * Broadcasts a standalone SOS to friends with location sharing (Req 25.1,
 * 25.7). This screen only ever renders with NO active group, so this is
 * always the standalone channel — the same semantics as MapScreen's
 * `broadcastSosPin(svc, null, coord)` branch, but calling rallyService
 * directly instead of importing MapScreen (whose module constructs SQLite /
 * motion-state services at import time and is owned by another change this
 * wave). Errors propagate so the caller can show the call-911 alert instead
 * of failing silently. Exported for tests.
 */
export function broadcastIdleSos(
  svc: Pick<typeof rallyService, 'broadcastStandaloneSos'>,
  coord: { lat: number; lng: number },
): Promise<SosPin> {
  return svc.broadcastStandaloneSos(coord.lat, coord.lng);
}

/**
 * Cancels a standalone SOS (Req 25.7) — no group here, so always the
 * standalone endpoint, mirroring MapScreen's `cancelSosPin(svc, null, sosId)`
 * branch. Exported for tests.
 */
export function cancelIdleSos(
  svc: Pick<typeof rallyService, 'cancelStandaloneSos'>,
  sosId: string,
): Promise<void> {
  return svc.cancelStandaloneSos(sosId);
}

/** "3m ago" / "2h ago" style relative timestamp for a friend's SOS pin. */
function formatSosTimeAgo(createdAt: string): string {
  const mins = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

export default function IdleMapScreen() {
  const router = useRouter();
  // Set by FriendsScreen's "View on map" button (Req 70) — once the friend-
  // locations poll below resolves, we center on this friend if they're
  // currently sharing, or tell the user if they're not.
  const { focusFriendId, focusFriendName } = useLocalSearchParams<{
    focusFriendId?: string;
    focusFriendName?: string;
  }>();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const mapRef = useRef<MapView>(null);
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const mapStyle = useSettingsStore((s) => s.mapStyle);
  const shareLocationWithFriends = useSettingsStore((s) => s.shareLocationWithFriends);

  const [initialRegion, setInitialRegion] = useState(DEFAULT_REGION);
  const [locating, setLocating] = useState(true);
  const [showPrescreen, setShowPrescreen] = useState(false);
  const [nearbyGroups, setNearbyGroups] = useState<NearbyGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<NearbyGroup | null>(null);
  const [showSuggestion, setShowSuggestion] = useState(false);
  const [speedKph, setSpeedKph] = useState<number | null>(null);
  const [headingDeg, setHeadingDeg] = useState<number>(0);
  const [hudVisible, setHudVisible] = useState(true);
  // Friends' standalone SOS pins (Req 25.7) — keyed by SOS id, populated via the
  // personal-room `sos:alert` socket event since there's no active group here.
  const [friendSosPins, setFriendSosPins] = useState<Map<string, SosPin>>(new Map());
  // The user's OWN standalone SOS (Req 25.1, 25.7). Unlike MapScreen's grouped
  // path there is no socket echo without a group, so the pin returned by the
  // POST is tracked (and rendered) locally, and cancel clears it locally too.
  const [mySosPin, setMySosPin] = useState<SosPin | null>(null);
  const [showSosConfirm, setShowSosConfirm] = useState(false);
  // Friends currently sharing their live location with us (Req 70) — populated
  // via periodic poll (see below) rather than a socket push.
  const [friendLocations, setFriendLocations] = useState<FriendLocationPin[]>([]);
  // True once the friend-locations poll has resolved at least once, so the
  // focusFriendId handling below doesn't fire on the empty initial state.
  const [friendLocationsLoaded, setFriendLocationsLoaded] = useState(false);

  const isSuggestionShown = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const locationSubRef = useRef<ExpoLocation.LocationSubscription | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const wsServiceRef = useRef<WebSocketService | null>(null);
  const friendNamesRef = useRef<Record<string, string>>({});
  // Mirrors the shareLocationWithFriends store value into a ref so the GPS
  // watch callback (registered once via a stable useCallback) always reads
  // the *current* toggle state instead of a stale one — required so flipping
  // the toggle off stops emission immediately, not on the next remount.
  const shareLocationRef = useRef(shareLocationWithFriends);
  useEffect(() => { shareLocationRef.current = shareLocationWithFriends; }, [shareLocationWithFriends]);
  // Guards the one-time focus/center-on-friend handling below so it only
  // fires once per screen visit, not on every 20s poll refresh.
  const focusHandledRef = useRef(false);
  // Last known own GPS fix — a ref (not state) because it's only read at
  // event time (sending an SOS), and the GPS watch ticks every ~2s.
  const myLocationRef = useRef<{ lat: number; lng: number } | null>(null);

  // Animations
  const pulseOpacity = useRef(new Animated.Value(1)).current;
  const pulseScale = useRef(new Animated.Value(1)).current;
  const toastAnim = useRef(new Animated.Value(0)).current;
  const [showToast, setShowToast] = useState(true);
  const suggestionAnim = useRef(new Animated.Value(0)).current;
  const selectedCardAnim = useRef(new Animated.Value(0)).current;
  // Quick-action alert toast (mirrors MapScreen's showQuickAlert) — used for
  // the "SOS sent" confirmation since there's no socket echo to surface it.
  const quickAlertAnim = useRef(new Animated.Value(-160)).current;
  const quickAlertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [quickAlertText, setQuickAlertText] = useState<string | null>(null);

  // GPS locating pulse
  const reduceMotion = useReduceMotion();
  useEffect(() => {
    if (!locating) return;
    if (reduceMotion) {
      // OS reduce-motion: static locating indicator — slightly enlarged and
      // fully opaque so "acquiring GPS" is still visible without the pulse.
      pulseOpacity.setValue(1);
      pulseScale.setValue(1.2);
      return () => {
        pulseOpacity.setValue(1);
        pulseScale.setValue(1);
      };
    }
    const loop = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(pulseOpacity, { toValue: 0.3, duration: 900, useNativeDriver: true }),
          Animated.timing(pulseOpacity, { toValue: 1, duration: 900, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(pulseScale, { toValue: 1.4, duration: 900, useNativeDriver: true }),
          Animated.timing(pulseScale, { toValue: 1, duration: 900, useNativeDriver: true }),
        ]),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [locating, pulseOpacity, pulseScale, reduceMotion]);

  // Welcome toast
  useEffect(() => {
    Animated.sequence([
      Animated.timing(toastAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
      Animated.delay(2200),
      Animated.timing(toastAnim, { toValue: 0, duration: 400, useNativeDriver: true }),
    ]).start(() => setShowToast(false));
  }, [toastAnim]);

  // Idle engagement after 30s
  useEffect(() => {
    idleTimerRef.current = setTimeout(() => {
      if (!isSuggestionShown.current) {
        isSuggestionShown.current = true;
        setShowSuggestion(true);
        Animated.sequence([
          Animated.timing(suggestionAnim, { toValue: 1, duration: 350, useNativeDriver: true }),
          Animated.delay(5000),
          Animated.timing(suggestionAnim, { toValue: 0, duration: 350, useNativeDriver: true }),
        ]).start(() => setShowSuggestion(false));
      }
    }, 30000);
    return () => { if (idleTimerRef.current) clearTimeout(idleTimerRef.current); };
  }, [suggestionAnim]);

  // Animate selected group card
  useEffect(() => {
    Animated.spring(selectedCardAnim, {
      toValue: selectedGroup ? 1 : 0,
      useNativeDriver: true,
      tension: 80,
      friction: 10,
    }).start();
  }, [selectedGroup, selectedCardAnim]);

  // Fetch friend display names once so a friend's SOS pin can show "who" rather
  // than a raw userId (mirrors MapScreen's memberNamesRef fetch for group members).
  useEffect(() => {
    if (!token) return;
    apiClient
      .get<{ friends: Array<{ userId: string; displayName?: string; callsign?: string | null }> }>('/api/v1/friends')
      .then((res) => {
        const names: Record<string, string> = {};
        for (const f of res.data.friends) {
          names[f.userId] = f.callsign ?? f.displayName ?? 'A friend';
        }
        friendNamesRef.current = names;
      })
      .catch(() => {});
  }, [token]);

  // Personal-room socket connection — there's no active group here, so this is the
  // only channel a friend's standalone SOS (`POST /sos` → `sos:alert`, broadcast to
  // `user:<id>`) can reach this screen through. WebSocketService's `auth` is sent
  // without a groupId, and the server now joins the personal room regardless of
  // whether the user has an active convoy (see apps/api/src/socket/socket.handler.ts).
  useEffect(() => {
    if (!token) return;
    const wsService = new WebSocketService({
      url: SOCKET_URL,
      auth: { token },
      // Mirrors MapScreen's in-group location-update cadence exactly (Req 70)
      // so the groupless friend-location broadcast below behaves identically.
      locationThrottleMs: 3_000,
      onAuthError: async () => {
        const newToken = await authService.refreshToken();
        if (!newToken) throw new Error('Token refresh failed');
        return newToken;
      },
      onAuthFailed: () => {
        useAuthStore.getState().signOut();
      },
    });
    const socket = wsService.connect();
    socketRef.current = socket;
    wsServiceRef.current = wsService;

    socket.on('sos:alert', (data: SosPin) => {
      setFriendSosPins((prev) => new Map(prev).set(data.id, data));
    });
    socket.on('sos:cancelled', ({ sosId }: { sosId: string }) => {
      setFriendSosPins((prev) => {
        const next = new Map(prev);
        next.delete(sosId);
        return next;
      });
    });

    return () => {
      wsService.disconnect();
      socketRef.current = null;
      wsServiceRef.current = null;
    };
  }, [token]);

  // Poll friends' shared locations (Req 70). A periodic poll rather than a
  // socket push is intentionally simpler here — the backend may not push
  // friend-location updates over sockets initially — and 20s is a reasonable
  // cadence for a slow-moving "where are my friends" overlay.
  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;

    const poll = async () => {
      try {
        // Documented contract (Task #69): GET /api/v1/friends/locations ->
        // { locations: [...] }. Friends who aren't sharing or whose cache
        // expired are simply absent — never null entries — but we still
        // filter defensively since the backend is landing in parallel.
        const res = await apiClient.get<{ locations: FriendLocationPin[] }>(
          '/api/v1/friends/locations',
        );
        const raw = res.data?.locations ?? [];
        const pins = raw.filter(
          (f): f is FriendLocationPin =>
            !!f && typeof f.userId === 'string' && typeof f.lat === 'number' && typeof f.lng === 'number',
        );
        if (!cancelled) setFriendLocations(pins);
      } catch {
        // non-fatal — friend pins simply don't refresh this cycle
      } finally {
        if (!cancelled) setFriendLocationsLoaded(true);
      }
    };

    poll();
    const interval = setInterval(poll, 20000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [token]);

  // Center on a specific friend when arriving via FriendsScreen's "View on
  // map" button (Req 70). Waits for the first friend-locations poll so we
  // don't prematurely report "not sharing" before data has loaded, and fires
  // only once per visit so it doesn't fight the user's own map interactions.
  useEffect(() => {
    if (!focusFriendId || focusHandledRef.current || !friendLocationsLoaded) return;
    focusHandledRef.current = true;
    const friend = friendLocations.find((f) => f.userId === focusFriendId);
    if (friend) {
      mapRef.current?.animateToRegion(
        { latitude: friend.lat, longitude: friend.lng, latitudeDelta: 0.02, longitudeDelta: 0.02 },
        500,
      );
      Alert.alert(
        friend.displayName ?? focusFriendName ?? 'Friend',
        `Sharing their live location — last updated ${formatLocTimeAgo(friend.ts)}.`,
      );
    } else {
      Alert.alert(
        'Not sharing location',
        `${focusFriendName ?? 'This friend'} isn't currently sharing their live location.`,
      );
    }
  }, [focusFriendId, focusFriendName, friendLocations, friendLocationsLoaded]);

  const friendSosPinList = useMemo(() => Array.from(friendSosPins.values()), [friendSosPins]);

  const handleFriendLocationPress = useCallback((pin: FriendLocationPin) => {
    Alert.alert(
      pin.displayName ?? 'A friend',
      `Last updated ${formatLocTimeAgo(pin.ts)}`,
    );
  }, []);

  const handleSosPinPress = useCallback((pin: SosPin) => {
    const name = friendNamesRef.current[pin.userId] ?? 'A friend';
    Alert.alert(
      `${SOS_EMOJI[pin.type] ?? '🆘'} ${name} needs help`,
      `Sent ${formatSosTimeAgo(pin.createdAt)}\n${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`,
      [
        { text: 'Dismiss', style: 'cancel' },
        { text: 'Get Directions', onPress: () => openMapsDirections(pin.lat, pin.lng, `${name}'s SOS`) },
      ],
    );
  }, []);

  // Auto-dismiss timer cleanup — same rationale as MapScreen: navigating away
  // while the 4s toast timer is pending must not setState on an unmounted tree.
  useEffect(() => {
    return () => {
      if (quickAlertTimerRef.current) clearTimeout(quickAlertTimerRef.current);
    };
  }, []);

  const showQuickAlert = useCallback((text: string) => {
    if (quickAlertTimerRef.current) clearTimeout(quickAlertTimerRef.current);
    setQuickAlertText(text);
    quickAlertAnim.setValue(-160);
    Animated.spring(quickAlertAnim, { toValue: 0, useNativeDriver: true, damping: 15, stiffness: 200 }).start();
    quickAlertTimerRef.current = setTimeout(() => {
      Animated.timing(quickAlertAnim, { toValue: -160, duration: 300, useNativeDriver: true }).start(
        () => setQuickAlertText(null),
      );
    }, 4000);
  }, [quickAlertAnim]);

  // SOS entry point (Req 25.1) — mirrors MapScreen's flow. There are no convoy
  // members to pick from here (this screen only renders group-less), so the
  // person picker collapses to its only remaining option ("Yourself") and we
  // go straight to the same confirm modal MapScreen shows.
  const handleSosPress = useCallback(() => {
    if (!myLocationRef.current) {
      // Same situation MapScreen's picker surfaces as a disabled
      // "Location unavailable – cannot broadcast" row.
      Alert.alert('Location unavailable', 'Enable location permissions to send an SOS.');
      return;
    }
    setShowSosConfirm(true);
  }, []);

  const confirmSos = useCallback(async () => {
    setShowSosConfirm(false);
    const coord = myLocationRef.current;
    if (!coord) return;
    try {
      const pin = await broadcastIdleSos(rallyService, coord);
      // No group ⇒ no socket echo of `sos:alert` back to us — surface the pin
      // and a sent-confirmation locally (same bookkeeping as MapScreen's
      // standalone branch).
      setMySosPin(pin);
      showQuickAlert('🆘 SOS sent to friends sharing location with you');
      // Distinct strong pattern so the sender gets unmistakable confirmation
      // the emergency broadcast went out (same haptic MapScreen uses).
      HapticService.trigger('error');
    } catch {
      HapticService.trigger('warning');
      // Never fail silently on a safety-critical action — point the user at
      // the one channel that doesn't depend on this app's connectivity.
      Alert.alert(
        'SOS Not Sent',
        "Your emergency alert didn't reach your friends. If this is a real emergency, call 911 directly.",
      );
    }
  }, [showQuickAlert]);

  const cancelMySos = useCallback(async () => {
    if (!mySosPin) return;
    try {
      await cancelIdleSos(rallyService, mySosPin.id);
      // No socket echo of `sos:cancelled` without a group — clear locally.
      setMySosPin(null);
    } catch {
      Alert.alert('Error', 'Could not cancel SOS.');
    }
  }, [mySosPin]);

  const clearIdleTimer = () => {
    if (idleTimerRef.current) { clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
  };

  const fetchNearbyGroups = async (lat: number, lng: number) => {
    try {
      const res = await apiClient.get<{ groups: NearbyGroup[]; total: number }>(
        `/api/v1/groups?accessType=open&lat=${lat}&lng=${lng}&limit=10`,
      );
      setNearbyGroups(res.data.groups ?? []);
    } catch {
      // non-fatal
    }
  };

  const startLiveLocation = useCallback(async () => {
    try {
      locationSubRef.current = await ExpoLocation.watchPositionAsync(
        { accuracy: ExpoLocation.Accuracy.Balanced, timeInterval: 2000, distanceInterval: 5 },
        (loc) => {
          myLocationRef.current = { lat: loc.coords.latitude, lng: loc.coords.longitude };
          const spd = loc.coords.speed;
          const speedKphVal = spd !== null && spd >= 0 ? Math.round(spd * 3.6) : null;
          if (speedKphVal !== null) setSpeedKph(speedKphVal);
          if (loc.coords.heading !== null && loc.coords.heading >= 0) {
            setHeadingDeg(loc.coords.heading);
          }

          // Groupless friend-location sharing (Req 70) — this screen only
          // renders when there's no active group, so the sole gate here is
          // the user's opt-in toggle. Mirrors MapScreen's in-group payload
          // shape exactly ({ lat, lng, heading, speed_kph, ts }) so the
          // backend's shared `location:update` handler parses it the same
          // way; emission stops immediately once the toggle flips off since
          // we check the ref (not a stale closure value) on every GPS tick.
          if (shareLocationRef.current) {
            wsServiceRef.current?.emitLocation({
              lat: loc.coords.latitude,
              lng: loc.coords.longitude,
              heading: loc.coords.heading !== null && loc.coords.heading >= 0 ? loc.coords.heading : 0,
              speed_kph: speedKphVal ?? 0,
              ts: loc.timestamp,
            });
          }
        },
      );
    } catch {
      // non-fatal — HUD just stays hidden
    }
  }, []);

  const requestLocationAndCenter = async (mounted: { current: boolean }) => {
    const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
    if (!mounted.current || status !== 'granted') {
      if (mounted.current) setLocating(false);
      return;
    }
    const loc = await ExpoLocation.getCurrentPositionAsync({ accuracy: ExpoLocation.Accuracy.Balanced });
    if (!mounted.current) return;
    const { latitude, longitude } = loc.coords;
    myLocationRef.current = { lat: latitude, lng: longitude };
    const region = { latitude, longitude, latitudeDelta: 0.05, longitudeDelta: 0.05 };
    setInitialRegion(region);
    mapRef.current?.animateToRegion(region, 500);
    setLocating(false);
    fetchNearbyGroups(latitude, longitude);
    startLiveLocation();
  };

  useEffect(() => {
    const mounted = { current: true };
    (async () => {
      const { status } = await ExpoLocation.getForegroundPermissionsAsync();
      if (status === 'granted') {
        await requestLocationAndCenter(mounted);
      } else {
        setLocating(false);
        setShowPrescreen(true);
      }
    })();
    return () => {
      mounted.current = false;
      locationSubRef.current?.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePrescreenAllow = async () => {
    setShowPrescreen(false);
    setLocating(true);
    const mounted = { current: true };
    await requestLocationAndCenter(mounted);
  };

  const recenter = () => {
    clearIdleTimer();
    ExpoLocation.getCurrentPositionAsync({ accuracy: ExpoLocation.Accuracy.Balanced })
      .then((loc) => {
        myLocationRef.current = { lat: loc.coords.latitude, lng: loc.coords.longitude };
        mapRef.current?.animateToRegion({
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05,
        }, 500);
      })
      .catch(() => Alert.alert('Location unavailable', 'Enable location in Settings.'));
  };

  const handleBrowseGroups = () => {
    clearIdleTimer();
    router.push('/search' as never);
  };

  const handleJoinGroup = (groupId: string) => {
    clearIdleTimer();
    router.push(`/group/${groupId}` as never);
  };

  const cardHeight = nearbyGroups.length > 0 ? 320 + insets.bottom : 260 + insets.bottom;

  // Stack the "you're sharing" banner below whichever of the greeting pill /
  // nearby-convoys pill are currently showing, so it never overlaps them.
  const topPillsShown = (user ? 1 : 0) + (nearbyGroups.length > 0 ? 1 : 0);
  const sharingBannerTop = insets.top + 12 + topPillsShown * 44;

  return (
    <View style={styles.container}>
      <LocationPermissionPrescreen
        visible={showPrescreen}
        onAllow={handlePrescreenAllow}
        onSkip={() => { setShowPrescreen(false); setLocating(false); }}
      />

      <MapView
        ref={mapRef}
        provider={PROVIDER_DEFAULT}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        showsUserLocation
        mapType={mapStyle}
      >
        {/* Nearby convoy markers */}
        {nearbyGroups.map((group) =>
          group.lat && group.lng ? (
            <Marker
              key={group.id}
              coordinate={{ latitude: group.lat, longitude: group.lng }}
              onPress={() => setSelectedGroup(group)}
              title={`${group.name} — ${group.memberCount} members`}
            >
              <View style={styles.convoyMarker}>
                <Text style={styles.convoyMarkerText}>{group.memberCount}</Text>
              </View>
            </Marker>
          ) : null,
        )}

        {/* Friends' standalone SOS pins (Req 25.7) */}
        {friendSosPinList.map((pin) => (
          <Marker
            key={pin.id}
            coordinate={{ latitude: pin.lat, longitude: pin.lng }}
            onPress={() => handleSosPinPress(pin)}
            title={`${friendNamesRef.current[pin.userId] ?? 'A friend'} needs help`}
            description={`Sent ${formatSosTimeAgo(pin.createdAt)} — tap for directions`}
          >
            <View style={styles.sosMarker}>
              <Text style={styles.sosMarkerText}>{SOS_EMOJI[pin.type] ?? '🆘'}</Text>
            </View>
          </Marker>
        ))}

        {/* Own active standalone SOS (Req 25.1, 25.7) — rendered locally from
            the POST response since there's no group socket to echo it back. */}
        {mySosPin && (
          <Marker
            key={mySosPin.id}
            coordinate={{ latitude: mySosPin.lat, longitude: mySosPin.lng }}
            title="Your SOS"
            description="Visible to friends sharing location with you"
          >
            <View style={styles.sosMarker}>
              <Text style={styles.sosMarkerText}>{SOS_EMOJI[mySosPin.type] ?? '🆘'}</Text>
            </View>
          </Marker>
        )}

        {/* Friends sharing their live location with us (Req 70) */}
        {friendLocations.map((f) => (
          <Marker
            key={f.userId}
            coordinate={{ latitude: f.lat, longitude: f.lng }}
            onPress={() => handleFriendLocationPress(f)}
            title={f.displayName ?? 'A friend'}
            description={`Last updated ${formatLocTimeAgo(f.ts)}`}
          >
            <View style={styles.friendLocationMarker}>
              <Text style={styles.friendLocationMarkerText}>
                {(f.displayName ?? 'A').charAt(0).toUpperCase()}
              </Text>
            </View>
          </Marker>
        ))}
      </MapView>

      <View style={styles.dimOverlay} pointerEvents="none" />

      {/* GPS pulse while locating */}
      {locating && (
        <View style={styles.pulseWrapper} pointerEvents="none">
          <Animated.View
            style={[styles.pulseDot, { opacity: pulseOpacity, transform: [{ scale: pulseScale }] }]}
          />
        </View>
      )}

      {/* Time-based greeting. getGreeting() produces unbounded text (long
          first names), and this pill is centered across the *whole* width,
          so it can otherwise collide with the speed/compass HUD card
          (top-right, 64px wide) at the same vertical offset — the common
          case whenever logged in and not locating. Bounding the pill's width
          keeps it structurally clear of the HUD regardless of name length;
          numberOfLines/ellipsizeMode is a second line of defense in case a
          name is wide enough to hit that cap. */}
      {user && (
        <View style={[styles.greetingPill, { top: insets.top + 12 }]} pointerEvents="none">
          <Text style={styles.greetingText} numberOfLines={1} ellipsizeMode="tail">
            {getGreeting(user.displayName)}
          </Text>
        </View>
      )}

      {/* Nearby convoy count pill */}
      {nearbyGroups.length > 0 && (
        <TouchableOpacity
          style={[styles.nearbyPill, { top: user ? insets.top + 56 : insets.top + 12 }]}
          onPress={handleBrowseGroups}
          accessibilityRole="button"
          accessibilityLabel={`${nearbyGroups.length} convoys near you, tap to browse`}
        >
          <Ionicons name="car" size={14} color={colors.text} />
          <Text style={styles.nearbyPillText}>
            {' '}{nearbyGroups.length} convoy{nearbyGroups.length !== 1 ? 's' : ''} near you
          </Text>
        </TouchableOpacity>
      )}

      {/* "You're sharing" banner — makes it clear the current user's own live
          location is visible to friends right now, so they're never surprised. */}
      {shareLocationWithFriends && (
        <View
          style={[styles.sharingBanner, { top: sharingBannerTop }]}
          pointerEvents="none"
          accessibilityLabel="Your location is currently visible to friends"
        >
          <Text style={styles.sharingBannerText} numberOfLines={1} ellipsizeMode="tail">
            📍 Sharing your location with friends
          </Text>
        </View>
      )}

      {/* Welcome toast (no nearby convoys, no user greeting) */}
      {showToast && !user && nearbyGroups.length === 0 && (
        <Animated.View
          style={[styles.toast, { top: insets.top + 12, opacity: toastAnim }]}
          pointerEvents="none"
        >
          <Text style={styles.toastText}>Tap below to start your convoy</Text>
        </Animated.View>
      )}

      {/* Speed + Compass HUD */}
      {hudVisible && !locating && (
        <TouchableOpacity
          style={[styles.hudCard, { top: insets.top + 12, right: 12 }]}
          onPress={() => setHudVisible(false)}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={`Speed ${speedKph !== null ? `${speedKph} kilometers per hour` : 'unavailable'}. Tap to hide.`}
        >
          <Text style={styles.hudSpeed}>
            {speedKph !== null ? `${speedKph}` : '—'}
          </Text>
          <Text style={styles.hudUnit}>km/h</Text>
          <Animated.View
            style={{ transform: [{ rotate: `${headingDeg}deg` }], marginTop: 4 }}
          >
            <Ionicons name="navigate" size={18} color={colors.accent} />
          </Animated.View>
        </TouchableOpacity>
      )}

      {!hudVisible && (
        <TouchableOpacity
          style={[styles.hudToggle, { top: insets.top + 12, right: 12 }]}
          onPress={() => setHudVisible(true)}
          accessibilityRole="button"
          accessibilityLabel="Show speed and heading"
        >
          <Ionicons name="compass" size={22} color={colors.text} />
        </TouchableOpacity>
      )}

      {/* Re-center button */}
      <TouchableOpacity
        style={[styles.recenterBtn, { top: hudVisible ? insets.top + 100 : insets.top + 64 }]}
        onPress={recenter}
        accessibilityRole="button"
        accessibilityLabel="Re-center map"
      >
        <Ionicons name="locate" size={22} color={colors.text} />
      </TouchableOpacity>

      {/* SOS button (Req 25.1 — reachable at all times for authenticated
          members; guests never mount this screen but gate defensively).
          Mirrors MapScreen's FAB SOS item: card circle with the accent ring
          for contrast over map imagery (Req 40), flipping to the muted
          "cancel" treatment while the user's own SOS is active. */}
      {canSendSos(user) && (
        <View style={[styles.sosFabContainer, { bottom: cardHeight + 12 }]}>
          {mySosPin ? (
            <TouchableOpacity
              style={[styles.sosFab, styles.sosFabCancel, { flexDirection: 'row', gap: 4 }]}
              onPress={() => { void cancelMySos(); }}
              accessibilityRole="button"
              accessibilityLabel="Cancel SOS"
              accessibilityHint="Removes your active emergency alert"
            >
              <Ionicons name="close" size={14} color={colors.text} />
              <Text style={styles.sosFabText}>SOS</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.sosFab}
              onPress={handleSosPress}
              accessibilityRole="button"
              accessibilityLabel="Send SOS alert"
              accessibilityHint="Alerts your friends of an emergency"
            >
              <MaterialIcons name="sos" size={22} color={colors.accent} />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Quick-action alert toast — slides in from top (SOS sent confirmation) */}
      {quickAlertText != null && (
        <Animated.View
          style={[
            styles.quickAlertBanner,
            { top: insets.top + 8, transform: [{ translateY: quickAlertAnim }] },
          ]}
          accessibilityLiveRegion="polite"
        >
          <Text style={styles.quickAlertText} numberOfLines={1}>{quickAlertText}</Text>
        </Animated.View>
      )}

      {/* Idle engagement suggestion toast */}
      {showSuggestion && (
        <Animated.View style={[styles.suggestionToast, { bottom: cardHeight + 12, opacity: suggestionAnim }]}>
          <View style={styles.suggestionStrip} />
          <TouchableOpacity
            style={styles.suggestionContent}
            onPress={() => { setShowSuggestion(false); handleBrowseGroups(); }}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Find a convoy near you"
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="car" size={14} color={colors.text} />
              <Text style={styles.suggestionText}>Ready to roll? Find a convoy near you</Text>
            </View>
          </TouchableOpacity>
        </Animated.View>
      )}

      {/* Selected group card (marker tap) */}
      {selectedGroup && (
        <Animated.View
          style={[
            styles.selectedCard,
            { bottom: cardHeight + 12, opacity: selectedCardAnim, transform: [{ translateY: selectedCardAnim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }] },
          ]}
        >
          <View style={styles.selectedCardInner}>
            <View style={{ flex: 1 }}>
              <Text style={styles.selectedCardName}>{selectedGroup.name}</Text>
              <Text style={styles.selectedCardMeta}>{selectedGroup.memberCount} members active</Text>
            </View>
            <TouchableOpacity
              style={styles.joinBtn}
              onPress={() => handleJoinGroup(selectedGroup.id)}
              accessibilityRole="button"
              accessibilityLabel={`Join ${selectedGroup.name}`}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.joinBtnText}>Join →</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setSelectedGroup(null)}
              style={styles.dismissBtn}
              accessibilityRole="button"
              accessibilityLabel="Dismiss group card"
              hitSlop={{ top: 8, bottom: 8, left: 0, right: 8 }}
            >
              <Ionicons name="close" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
        </Animated.View>
      )}

      {/* Bottom CTA sheet */}
      <View style={[styles.bottomSheet, { height: cardHeight }]}>
        <View style={styles.sheetHandle} />
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 10 }}>
          <Ionicons name="car" size={18} color={colors.text} />
          <Text style={[styles.sheetTitle, { marginBottom: 0 }]}>Start or Join a Convoy</Text>
        </View>

        {/* Nearby convoys mini-list */}
        {nearbyGroups.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.nearbyScroll}
            contentContainerStyle={styles.nearbyScrollContent}
          >
            {nearbyGroups.slice(0, 5).map((g) => (
              <TouchableOpacity
                key={g.id}
                style={styles.nearbyGroupChip}
                onPress={() => handleJoinGroup(g.id)}
                accessibilityRole="button"
                accessibilityLabel={`Join ${g.name}, ${g.memberCount} member${g.memberCount !== 1 ? 's' : ''}`}
              >
                <Text style={styles.nearbyGroupName} numberOfLines={1}>{g.name}</Text>
                <View style={[styles.memberPill, { flexDirection: 'row', alignItems: 'center', gap: 3 }]}>
                  <Text style={styles.memberPillText}>{g.memberCount}</Text>
                  <Ionicons name="car" size={10} color={colors.accent} />
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {/* Empty state when no nearby groups */}
        {nearbyGroups.length === 0 && !locating && (
          <View style={styles.emptyState}>
            <MaterialCommunityIcons name="road-variant" size={28} color={colors.textMuted} style={{ marginBottom: 4 }} />
            <Text style={styles.emptyTitle}>No active convoys nearby</Text>
            <Text style={styles.emptySubtitle}>Start one and invite your crew</Text>
          </View>
        )}

        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={() => { clearIdleTimer(); router.push('/(tabs)/convoy'); }}
          accessibilityRole="button"
          accessibilityLabel="Create a new group"
        >
          <Text style={styles.primaryBtnText}>Create Group</Text>
          <Text style={styles.btnSubtitle}>Lead your own convoy</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.outlineBtn}
          onPress={() => { clearIdleTimer(); router.push('/join' as never); }}
          accessibilityRole="button"
          accessibilityLabel="Join a group with a code"
        >
          <Text style={styles.outlineBtnText}>Join with Code</Text>
          <Text style={styles.outlineBtnSubtitle}>Enter 6-character code</Text>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.ghostBtn, { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }]} onPress={handleBrowseGroups} accessibilityRole="button">
          <Ionicons name="search" size={14} color={colors.textMuted} />
          <Text style={styles.ghostBtnText}>Browse Groups →</Text>
        </TouchableOpacity>
      </View>

      {/* SOS confirm modal — same structure and copy as MapScreen's groupless
          branch so the two screens feel identical (Req 25.1, 25.7). */}
      <Modal
        transparent
        visible={showSosConfirm}
        animationType="fade"
        onRequestClose={() => setShowSosConfirm(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <MaterialIcons name="sos" size={20} color={colors.accent} />
              <Text style={styles.modalTitle}>Send SOS Alert?</Text>
            </View>
            <Text style={styles.modalBody}>
              This will broadcast your location to your friends with location sharing as an emergency alert.
            </Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => setShowSosConfirm(false)}
                accessibilityRole="button"
                accessibilityLabel="Cancel SOS"
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalConfirm}
                onPress={() => { void confirmSos(); }}
                accessibilityRole="button"
                accessibilityLabel="Confirm and send SOS emergency alert"
              >
                <Text style={styles.modalConfirmText}>SEND SOS</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function makeStyles(colors: ThemeColors) {
return StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },

  dimOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#00000033',
  },

  pulseWrapper: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseDot: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(220,20,60,0.3)',
  },

  // Convoy map markers — these badges float over map imagery (not the app's own
  // surface), so their ring/label stay fixed white for contrast against the
  // crimson fill regardless of theme, same rationale as MapScreen's MemberMarkerView.
  convoyMarker: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#FFFFFF',
    shadowColor: colors.accent,
    shadowOpacity: 0.5,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  convoyMarkerText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },

  // Friend SOS pin
  sosMarker: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#FFFFFF',
    shadowColor: colors.accent,
    shadowOpacity: 0.7,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 8,
  },
  sosMarkerText: {
    fontSize: 20,
  },

  // Friend shared-location pin
  friendLocationMarker: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#3B82F6',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#FFFFFF',
    shadowColor: '#3B82F6',
    shadowOpacity: 0.6,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  friendLocationMarkerText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },

  // Greeting pill. maxWidth caps how far a long name can stretch this
  // centered pill so it structurally cannot reach the HUD card in the
  // top-right regardless of display-name length (see the collision note
  // above the JSX usage).
  greetingPill: {
    position: 'absolute',
    alignSelf: 'center',
    maxWidth: '55%',
    backgroundColor: 'rgba(28,28,28,0.92)',
    borderRadius: 20,
    paddingVertical: 7,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.border,
    zIndex: 20,
  },
  // greetingPill's background is a fixed dark translucent chip regardless of app
  // theme (it floats over the map), so its text stays fixed white.
  greetingText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.2,
  },

  nearbyPill: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderWidth: 1,
    borderColor: colors.border,
    zIndex: 20,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
  nearbyPillText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.2,
  },

  sharingBanner: {
    position: 'absolute',
    alignSelf: 'center',
    maxWidth: '70%',
    backgroundColor: 'rgba(59,130,246,0.18)',
    borderRadius: 20,
    paddingVertical: 7,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.4)',
    zIndex: 20,
  },
  sharingBannerText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.2,
  },

  toast: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: '#1C1C1Cee',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderWidth: 1,
    borderColor: colors.border,
  },
  // toast's background is a fixed dark translucent chip regardless of app theme.
  toastText: { color: '#FFFFFF', fontSize: 13, fontWeight: '500', letterSpacing: 0.2 },

  // Speed / Compass HUD
  hudCard: {
    position: 'absolute',
    width: 64,
    backgroundColor: 'rgba(28,28,28,0.92)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
    zIndex: 15,
  },
  // hudCard's background is a fixed dark translucent chip regardless of app theme
  // (it floats over the map surface), so its text stays fixed light rather than
  // following colors.text/colors.textMuted.
  hudSpeed: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '800',
    lineHeight: 22,
  },
  hudUnit: {
    color: '#888888',
    fontSize: 10,
    fontWeight: '500',
    letterSpacing: 0.5,
  },
  hudCompass: {
    color: colors.accent,
    fontSize: 20,
    fontWeight: '700',
    marginTop: 4,
  },
  hudToggle: {
    position: 'absolute',
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    zIndex: 15,
  },

  recenterBtn: {
    position: 'absolute',
    right: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
    zIndex: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  recenterText: { fontSize: 22, color: colors.text },

  // SOS button (Req 25.1, 40) — bottom-right, just above the CTA sheet.
  // Mirrors MapScreen's fabItem/fabSosItem treatment: card-colored circle
  // with a 2px accent ring + shadow so it reads clearly over map imagery
  // in both themes; the accent "sos" glyph carries the emergency color.
  sosFabContainer: {
    position: 'absolute',
    right: 12,
    alignItems: 'center',
    zIndex: 20,
  },
  sosFab: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.accent,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
  // While own SOS is active the button flips to the muted "cancel" treatment
  // (same as MapScreen's fabSosCancelItem).
  sosFabCancel: { borderColor: colors.border, backgroundColor: colors.border },
  sosFabText: { color: colors.text, fontWeight: '800', fontSize: 11 },

  // Quick-action alert toast (mirrors MapScreen's quickAlertBanner)
  quickAlertBanner: {
    position: 'absolute',
    left: 16,
    right: 16,
    backgroundColor: colors.card,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#F59E0B44',
    borderLeftWidth: 4,
    borderLeftColor: colors.warning,
    zIndex: 30,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 12,
  },
  quickAlertText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },

  // SOS confirm modal (same treatment as MapScreen's)
  modalOverlay: { flex: 1, backgroundColor: '#00000099', alignItems: 'center', justifyContent: 'center' },
  modalBox: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 24,
    marginHorizontal: 32,
    borderWidth: 2,
    borderColor: colors.accent,
  },
  modalTitle: { color: colors.text, fontSize: 20, fontWeight: '800' },
  modalBody: { color: colors.textMuted, fontSize: 14, lineHeight: 20, marginBottom: 20 },
  modalActions: { flexDirection: 'row', gap: 12 },
  modalCancel: { flex: 1, paddingVertical: 12, borderRadius: 8, backgroundColor: colors.border, alignItems: 'center' },
  modalCancelText: { color: colors.text, fontWeight: '600' },
  modalConfirm: { flex: 1, paddingVertical: 12, borderRadius: 8, backgroundColor: colors.accent, alignItems: 'center', borderWidth: 2, borderColor: '#FF8080' },
  modalConfirmText: { color: '#fff', fontWeight: '900', fontSize: 15 },

  // right: 76 (not 16) so these transient cards — anchored at the same
  // bottom offset as the always-present SOS button — never cover it
  // (Req 25.1: SOS reachable at all times).
  suggestionToast: {
    position: 'absolute',
    left: 16,
    right: 76,
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 8,
    zIndex: 30,
  },
  suggestionStrip: { width: 4, backgroundColor: colors.accent },
  suggestionContent: { flex: 1, paddingVertical: 14, paddingHorizontal: 14 },
  suggestionText: { color: colors.text, fontSize: 14, fontWeight: '600' },

  // Selected group card (marker tap) — right: 76 for the same SOS-button
  // clearance as suggestionToast above.
  selectedCard: {
    position: 'absolute',
    left: 16,
    right: 76,
    zIndex: 25,
  },
  selectedCardInner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 10,
  },
  selectedCardName: { color: colors.text, fontSize: 15, fontWeight: '700' },
  selectedCardMeta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  joinBtn: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginLeft: 10,
  },
  // joinBtn's background is the fixed-value accent color (same in both themes),
  // so its label stays fixed white for contrast.
  joinBtnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  dismissBtn: { paddingLeft: 10, paddingRight: 22, paddingVertical: 13 },
  dismissText: { color: colors.textMuted, fontSize: 16 },

  bottomSheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.bg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 24,
    paddingTop: 12,
    shadowColor: '#000',
    shadowOpacity: 0.6,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -4 },
    elevation: 20,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: 'center',
    marginBottom: 12,
  },
  sheetTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 0.3,
    marginBottom: 10,
    textAlign: 'center',
  },

  // Nearby convoys horizontal scroll
  nearbyScroll: { marginBottom: 10, maxHeight: 76 },
  nearbyScrollContent: { paddingHorizontal: 2 },
  nearbyGroupChip: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginRight: 10,
    minWidth: 120,
    maxWidth: 160,
    alignItems: 'flex-start',
  },
  nearbyGroupName: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
  },
  memberPill: {
    backgroundColor: 'rgba(220,20,60,0.15)',
    borderRadius: 8,
    paddingVertical: 2,
    paddingHorizontal: 7,
    borderWidth: 1,
    borderColor: 'rgba(220,20,60,0.3)',
  },
  memberPillText: { color: colors.accent, fontSize: 11, fontWeight: '600' },

  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingVertical: 8,
    marginBottom: 8,
  },
  emptyEmoji: { fontSize: 28, marginBottom: 4 },
  emptyTitle: { color: colors.text, fontSize: 14, fontWeight: '600', marginBottom: 2 },
  emptySubtitle: { color: colors.textMuted, fontSize: 12 },

  primaryBtn: {
    backgroundColor: colors.accent,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
    shadowColor: colors.accent,
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  // primaryBtn's background is the fixed-value accent color (same in both themes),
  // so its label stays fixed white for contrast.
  primaryBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', letterSpacing: 0.3 },
  btnSubtitle: { color: 'rgba(255,255,255,0.65)', fontSize: 12, fontWeight: '400', marginTop: 2 },
  outlineBtn: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.accent,
    marginBottom: 10,
  },
  outlineBtnText: { color: colors.accent, fontSize: 16, fontWeight: '600', letterSpacing: 0.3 },
  outlineBtnSubtitle: { color: colors.textMuted, fontSize: 12, fontWeight: '400', marginTop: 2 },
  ghostBtn: { alignItems: 'center', paddingVertical: 10 },
  ghostBtnText: { color: colors.textMuted, fontSize: 14, fontWeight: '500' },
});
}
