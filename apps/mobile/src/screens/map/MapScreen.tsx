import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import MapView, { Marker, Polyline, LongPressEvent, PROVIDER_DEFAULT } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ExpoLocation from 'expo-location';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '../../stores/authStore';
import { useSocketStore } from '../../stores/socketStore';
import { useSettingsStore } from '../../stores/settingsStore';
import PTTLogPanel from '../../components/PTTLogPanel';
import { authService } from '../../services/AuthService';
import { useLocationStore, MemberLocation } from '../../stores/locationStore';
import { rallyService, RallyPoint, SosPin } from '../../services/RallyService';
import { apiClient } from '../../services/apiClient';
import { HazardType } from '../../services/HazardService';
import DestinationSearch, { SearchResult } from '../../components/DestinationSearch';
import HazardPicker from '../../components/HazardPicker';
import SpeedLimitHUD from '../../components/SpeedLimitHUD';
import FuelSuggestionBanner from '../../components/FuelSuggestionBanner';
import { SQLiteOfflineDB } from '../../services/OfflineCacheService';
import { MotionStateService } from '../../services/MotionStateService';
import { PTTService } from '../../services/PTTService';
import { agoraEngineAdapter } from '../../services/AgoraEngineAdapter';
import { apiTokenFetcher } from '../../services/ApiTokenFetcher';
import { DriveService } from '../../services/DriveService';

interface GapAlert { memberId: string; distanceM: number }
interface SosAlert { pin: SosPin; memberName: string }
interface RouteAlternative {
  distanceM: number;
  durationS: number;
  geometry: { coordinates: [number, number][] };
}

interface Props {
  groupId: string;
  accessToken: string;
  socketUrl: string;
  gapThresholdM?: number;
  isAdmin?: boolean;
  pttChannelId?: string;
}

function formatElapsed(receivedAt: number): string {
  const s = Math.floor((Date.now() - receivedAt) / 1000);
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

const motionStateService = new MotionStateService();

const hapticAdapter = {
  impact: () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Haptics = require('expo-haptics');
      void Haptics.impactAsync('medium');
    } catch { /* expo-haptics not installed — non-fatal */ }
  },
};

// Module-level SQLite DB instance — initialised once per app lifecycle
const offlineDB = new SQLiteOfflineDB();
let offlineDBReady = false;
(async () => {
  try {
    await offlineDB.init();
    offlineDBReady = true;
  } catch {
    // Non-fatal — offline caching simply won't work
  }
})();

export default function MapScreen({ groupId, accessToken, socketUrl, isAdmin = false, pttChannelId }: Props) {
  const { user, token } = useAuthStore();
  const { memberLocations, stalePositions, updateMemberLocation, clearGroup, evictStale, setStalePositions, clearStalePositions } = useLocationStore();
  const insets = useSafeAreaInsets();

  const [gapAlerts, setGapAlerts]     = useState<GapAlert[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [rallyPoints, setRallyPoints] = useState<Map<string, RallyPoint>>(new Map());
  const [rallyAlert, setRallyAlert]   = useState<RallyPoint | null>(null);
  const [sosPins, setSosPins]         = useState<Map<string, SosPin>>(new Map());
  const [sosAlerts, setSosAlerts]     = useState<SosAlert[]>([]);
  const [mySosId, setMySosId]         = useState<string | null>(null);
  const [showSosConfirm, setShowSosConfirm]   = useState(false);
  const [pendingSosCoord, setPendingSosCoord]  = useState<{ lat: number; lng: number } | null>(null);
  const [pendingSosName, setPendingSosName]    = useState<string>('');
  const [showSosPicker, setShowSosPicker]     = useState(false);
  const [myLocation, setMyLocation]           = useState<{ lat: number; lng: number } | null>(null);
  const [mySpeedKph, setMySpeedKph]           = useState(0);
  const [isOnline, setIsOnline]               = useState(true);
  const [isPttTransmitting, setIsPttTransmitting] = useState(false);
  const [showHazardPicker, setShowHazardPicker]   = useState(false);
  const [showFuelBanner, setShowFuelBanner]         = useState(false);

  // FAB menu state
  const [fabOpen, setFabOpen]         = useState(false);
  const [fabPttActive, setFabPttActive] = useState(false);
  const fabPttLogIdRef                = useRef<string | null>(null);

  // Member panel tab
  const [panelTab, setPanelTab] = useState<'members' | 'pttlog'>('members');

  // Route planning
  const [routeCoords, setRouteCoords]             = useState<Array<{ latitude: number; longitude: number }>>([]);
  const [routeAlternatives, setRouteAlternatives] = useState<RouteAlternative[]>([]);
  const [selectedRouteIdx, setSelectedRouteIdx]   = useState<number>(0);
  const [showRouteModal, setShowRouteModal]       = useState(false);
  const [routeDestInput, setRouteDestInput]       = useState('');
  const [isCalcRoute, setIsCalcRoute]             = useState(false);

  // Driving mode (manual toggle)
  const [drivingModeActive, setDrivingModeActive] = useState(false);

  // Reactive socket and settings from shared stores
  const { socket } = useSocketStore();
  const mapStyle = useSettingsStore((s) => s.mapStyle);
  const scenicRouting = useSettingsStore((s) => s.scenicRouting);
  const pttMaxSeconds = useSettingsStore((s) => s.pttMaxSeconds);

  const socketRef       = useRef<Socket | null>(null);
  const mapRef          = useRef<MapView>(null);
  const mySosIdRef      = useRef<string | null>(null);
  const pttServiceRef   = useRef<PTTService | null>(null);
  const memberNamesRef  = useRef<Record<string, string>>({});
  const driveServiceRef = useRef(new DriveService());
  const memberCountRef  = useRef(0);
  const lastEmitRef     = useRef<number>(-3000); // throttle own-location emits to 1/3 s

  // Keep mySosIdRef in sync so the socket handler closure always sees the current value
  useEffect(() => { mySosIdRef.current = mySosId; }, [mySosId]);

  // Fetch member display names once when group is active so markers and panels show real names
  useEffect(() => {
    if (!groupId || !token) { memberNamesRef.current = {}; return; }
    apiClient
      .get<{ members: Array<{ userId: string; displayName?: string }> }>(`/api/v1/groups/${groupId}/members`)
      .then((res) => {
        const map: Record<string, string> = {};
        for (const m of res.data.members) {
          if (m.displayName) map[m.userId] = m.displayName;
        }
        memberNamesRef.current = map;
        memberCountRef.current = res.data.members.length;
      })
      .catch(() => {});
  }, [groupId, token]);

  // Evict members who haven't reported a location in 30s
  useEffect(() => {
    const interval = setInterval(() => evictStale(30_000), 30_000);
    return () => clearInterval(interval);
  }, [evictStale]);

  // Start a drive recording session for this group
  useEffect(() => {
    driveServiceRef.current.startSession();
  }, [groupId]);

  // Track own location — update local state, feed drive recorder, and broadcast to group
  useEffect(() => {
    let sub: ExpoLocation.LocationSubscription | null = null;
    let mounted = true;
    (async () => {
      const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
      if (status !== 'granted' || !mounted) return;
      sub = await ExpoLocation.watchPositionAsync(
        { accuracy: ExpoLocation.Accuracy.High, distanceInterval: 10 },
        (loc) => {
          const speedKph = (loc.coords.speed ?? 0) * 3.6;
          setMyLocation({ lat: loc.coords.latitude, lng: loc.coords.longitude });
          setMySpeedKph(speedKph);
          motionStateService.update(speedKph);
          driveServiceRef.current.addPoint(loc.coords.latitude, loc.coords.longitude, speedKph);
          // Broadcast own position to group (throttled to ≤1 emit per 3 s)
          const now = Date.now();
          if (socketRef.current?.connected && now - lastEmitRef.current >= 3000) {
            socketRef.current.emit('location:update', {
              lat: loc.coords.latitude,
              lng: loc.coords.longitude,
              heading: loc.coords.heading ?? 0,
              speed_kph: speedKph,
              ts: loc.timestamp,
            });
            lastEmitRef.current = now;
          }
        },
      );
      if (!mounted) sub.remove();
    })();
    return () => { mounted = false; sub?.remove(); };
  }, []);

  // PTTService lifecycle — create/destroy when socket or active channel changes
  useEffect(() => {
    if (!socket || !pttChannelId || !groupId) {
      if (pttServiceRef.current) {
        void pttServiceRef.current.leaveChannel();
        pttServiceRef.current = null;
      }
      return;
    }

    const service = new PTTService(
      agoraEngineAdapter,
      apiTokenFetcher,
      socket,
      hapticAdapter,
    );
    pttServiceRef.current = service;
    void service.joinChannel({ groupId, channelId: pttChannelId, maxSeconds: pttMaxSeconds });

    return () => {
      void service.leaveChannel();
      pttServiceRef.current = null;
    };
  }, [socket, pttChannelId, groupId]);

  // WebSocket
  useEffect(() => {
    if (!token || !groupId) return;
    const socket = io(socketUrl, { transports: ['websocket'], auth: { token, groupId } });
    socketRef.current = socket;
    useSocketStore.getState().setSocket(socket);

    // Forward our own logId to PTTService; keep fabPttLogIdRef for socket-only fallback
    socket.on('ptt:transmit', (data: { logId: string; userId: string }) => {
      if (data.userId === user?.id) {
        fabPttLogIdRef.current = data.logId;
        pttServiceRef.current?.setCurrentLogId(data.logId);
      }
    });

    socket.on('connect', () => {
      setIsConnected(true);
      setIsOnline(true);
      // Clear stale fallback data — live data is flowing again
      clearStalePositions();
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
      setIsOnline(false);
      // Load last-known positions from local cache so the map stays populated
      if (offlineDBReady) {
        offlineDB.getLastPositions(groupId).then((cached) => {
          if (cached.length > 0) {
            setStalePositions(
              cached.map((c) => ({
                userId: c.userId,
                lat: c.lat,
                lng: c.lng,
                heading: c.heading,
                speedKph: c.speedKph,
                ts: c.ts,
                receivedAt: c.savedAt,
                isStale: true,
              })),
            );
          }
        }).catch(() => { /* non-fatal */ });
      }
    });

    // Handle auth errors on connect/reconnect (e.g. expired access token during a network outage).
    // socket.io fires connect_error when the server middleware rejects the handshake.
    socket.on('connect_error', async (err: Error) => {
      const isAuthError =
        err.message.includes('401') ||
        err.message.toLowerCase().includes('unauthorized') ||
        err.message.toLowerCase().includes('token');

      if (!isAuthError) return;

      // Pause built-in reconnection while we refresh the token to avoid a retry storm.
      socket.io.opts.reconnection = false;

      try {
        const newToken = await authService.refreshToken();
        if (newToken) {
          socket.auth = { token: newToken, groupId };
          socket.io.opts.reconnection = true;
          socket.connect();
        } else {
          // refreshToken returned null — refresh token is also expired; force sign-out.
          useAuthStore.getState().signOut();
        }
      } catch {
        useAuthStore.getState().signOut();
      }
    });

    socket.on('location:update', (d: { userId: string; lat: number; lng: number; heading: number; speed_kph: number; ts: number }) => {
      if (d.userId === user?.id) return;
      const loc: MemberLocation = { userId: d.userId, displayName: memberNamesRef.current[d.userId], lat: d.lat, lng: d.lng, heading: d.heading, speedKph: d.speed_kph, ts: d.ts, receivedAt: Date.now() };
      updateMemberLocation(loc);
      // Persist for offline fallback
      if (offlineDBReady) {
        offlineDB.saveLastPosition({
          userId: d.userId,
          groupId,
          lat: d.lat,
          lng: d.lng,
          heading: d.heading,
          speedKph: d.speed_kph,
          ts: d.ts,
          savedAt: Date.now(),
        }).catch(() => { /* non-fatal */ });
      }
    });

    socket.on('gap:alert', (a: GapAlert) => setGapAlerts((p) => [...p.filter((x) => x.memberId !== a.memberId), a]));
    socket.on('route:pushed', (data: { geometry: { coordinates: [number, number][] } }) => {
      const coords = data.geometry.coordinates.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
      setRouteCoords(coords);
      setShowRouteModal(false);
      Alert.alert('Route Updated', 'The group leader pushed a new route to the convoy.');
    });
    socket.on('rally:set', (r: RallyPoint) => { setRallyPoints((p) => new Map(p).set(r.id, r)); setRallyAlert(r); });
    socket.on('rally:cancelled', ({ rallyId }: { rallyId: string }) => { setRallyPoints((p) => { const n = new Map(p); n.delete(rallyId); return n; }); setRallyAlert((p) => p?.id === rallyId ? null : p); });
    socket.on('sos:alert', (data: SosPin) => {
      setSosPins((p) => new Map(p).set(data.id, data));
      setSosAlerts((prev) => {
        if (prev.some((a) => a.pin.id === data.id)) return prev;
        const name = data.userId === user?.id ? 'You' : (memberNamesRef.current[data.userId] ?? `Member ${data.userId.slice(0, 6)}`);
        return [...prev, { pin: data, memberName: name }];
      });
    });
    socket.on('sos:cancelled', ({ sosId }: { sosId: string }) => { setSosPins((p) => { const n = new Map(p); n.delete(sosId); return n; }); setSosAlerts((p) => p.filter((a) => a.pin.id !== sosId)); if (mySosIdRef.current === sosId) setMySosId(null); });

    socket.on('group:ended', () => {
      void driveServiceRef.current.finishSession({
        groupId,
        memberCount: memberCountRef.current,
        offlineCache: offlineDB,
        api: { postDrive: (body) => apiClient.post('/api/v1/drives', body).then((r) => r.data) },
        isOnline: () => socket.connected,
      });
    });

    return () => {
      // Save drive before disconnecting — idempotent if group:ended already called it
      void driveServiceRef.current.finishSession({
        groupId,
        memberCount: memberCountRef.current,
        offlineCache: offlineDB,
        api: { postDrive: (body) => apiClient.post('/api/v1/drives', body).then((r) => r.data) },
        isOnline: () => true,
      });
      socket.disconnect();
      useSocketStore.getState().setSocket(null);
      clearGroup();
    };
  }, [token, groupId, socketUrl, updateMemberLocation, user?.id, clearGroup, setStalePositions, clearStalePositions]);

  const recenter = useCallback(() => {
    if (!mapRef.current) return;
    if (!myLocation) {
      Alert.alert('Location unavailable', 'Waiting for a GPS fix.');
      return;
    }
    const loc = myLocation;
    mapRef.current.animateToRegion({
      latitude: loc.lat,
      longitude: loc.lng,
      latitudeDelta: 0.01,
      longitudeDelta: 0.01,
    }, 500);
  }, [myLocation]);

  const handleLongPress = useCallback((e: LongPressEvent) => {
    if (!groupId) return;
    const { latitude: lat, longitude: lng } = e.nativeEvent.coordinate;
    Alert.alert('Meet Me Here', 'Broadcast this as a Rally Point to all group members?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Broadcast', onPress: async () => { try { await rallyService.broadcastRally(groupId, lat, lng); } catch { Alert.alert('Error', 'Could not broadcast rally point.'); } } },
    ]);
  }, [groupId]);

  // Open person picker — only available inside an active convoy
  const handleSosPress = useCallback(() => {
    setShowSosPicker(true);
  }, []);

  // Called when user picks a person from the picker
  const handlePickSosTarget = useCallback((name: string, lat: number, lng: number) => {
    setShowSosPicker(false);
    setPendingSosName(name);
    setPendingSosCoord({ lat, lng });
    setShowSosConfirm(true);
  }, []);

  const confirmSos = useCallback(async () => {
    setShowSosConfirm(false);
    if (!pendingSosCoord || !groupId) return;
    try {
      const pin = await rallyService.broadcastGroupSos(groupId, pendingSosCoord.lat, pendingSosCoord.lng);
      setMySosId(pin.id);
    } catch { Alert.alert('Error', 'Could not send SOS.'); }
    setPendingSosCoord(null);
    setPendingSosName('');
  }, [groupId, pendingSosCoord]);

  const cancelMySos = useCallback(async () => {
    if (!mySosId || !groupId) return;
    try { await rallyService.cancelSos(groupId, mySosId); } catch { Alert.alert('Error', 'Could not cancel SOS.'); }
  }, [groupId, mySosId]);

  const handleSearchSelect = useCallback((result: SearchResult) => {
    mapRef.current?.animateToRegion(
      {
        latitude: result.lat,
        longitude: result.lng,
        latitudeDelta: 0.02,
        longitudeDelta: 0.02,
      },
      600,
    );
  }, []);

  const handlePttStart = useCallback(() => {
    setIsPttTransmitting(true);
    if (pttServiceRef.current) {
      // PTTService handles socket emit + Agora mic open
      pttServiceRef.current.holdStart();
    } else if (socketRef.current && pttChannelId) {
      // Fallback: socket signalling only (no Agora audio)
      socketRef.current.emit('ptt:start', { channelId: pttChannelId });
    }
  }, [pttChannelId]);

  const handlePttEnd = useCallback(() => {
    setIsPttTransmitting(false);
    if (pttServiceRef.current) {
      // PTTService handles socket emit + Agora mic close
      pttServiceRef.current.holdEnd();
    } else if (socketRef.current && fabPttLogIdRef.current) {
      // Fallback: socket signalling only
      socketRef.current.emit('ptt:end', { logId: fabPttLogIdRef.current });
      fabPttLogIdRef.current = null;
    }
  }, [pttChannelId]);

  const handleCalculateRoute = useCallback(async () => {
    if (!myLocation || !routeDestInput.trim()) return;
    setIsCalcRoute(true);
    try {
      const searchRes = await apiClient.get<Array<{ lat: number; lng: number; name: string }>>(
        `/api/v1/places/search?q=${encodeURIComponent(routeDestInput.trim())}`,
      );
      const dest = Array.isArray(searchRes.data) ? searchRes.data[0] : undefined;
      if (!dest) { Alert.alert('No results', 'No location found for that search.'); return; }
      const routeRes = await apiClient.post<{ routes: RouteAlternative[] }>('/api/v1/routes/calculate', {
        origin: { lat: myLocation.lat, lng: myLocation.lng },
        destination: { lat: dest.lat, lng: dest.lng },
        scenic: scenicRouting,
      });
      const alts = routeRes.data.routes;
      setRouteAlternatives(alts);
      setSelectedRouteIdx(0);
      const coords = alts[0]?.geometry.coordinates.map(([lng, lat]) => ({ latitude: lat, longitude: lng })) ?? [];
      setRouteCoords(coords);
    } catch {
      Alert.alert('Error', 'Could not calculate route.');
    } finally {
      setIsCalcRoute(false);
    }
  }, [myLocation, routeDestInput]);

  const handleSelectRouteAlt = useCallback((idx: number) => {
    setSelectedRouteIdx(idx);
    const coords = routeAlternatives[idx]?.geometry.coordinates.map(([lng, lat]) => ({ latitude: lat, longitude: lng })) ?? [];
    setRouteCoords(coords);
  }, [routeAlternatives]);

  const handlePushRoute = useCallback(async () => {
    if (!groupId || !routeAlternatives[selectedRouteIdx]) return;
    try {
      await apiClient.post(`/api/v1/groups/${groupId}/route`, {
        geometry: routeAlternatives[selectedRouteIdx].geometry,
      });
      setShowRouteModal(false);
    } catch {
      Alert.alert('Error', 'Could not push route to group.');
    }
  }, [groupId, routeAlternatives, selectedRouteIdx]);

  const handleHazardSelect = useCallback(async (type: HazardType) => {
    if (!myLocation) {
      Alert.alert('Location required', 'Enable location permissions to report a hazard.');
      return;
    }
    try {
      await apiClient.post('/api/v1/hazards', { type, lat: myLocation.lat, lng: myLocation.lng });
    } catch {
      Alert.alert('Error', 'Could not report hazard. It will sync when you reconnect.');
    }
  }, [myLocation]);

  const handleFuelStationSelect = useCallback(async (station: { id: string; name: string; distanceM: number; lat: number; lng: number; address: string }) => {
    if (!groupId) return;
    try {
      await rallyService.broadcastRally(groupId, station.lat, station.lng);
      setShowFuelBanner(false);
    } catch {
      Alert.alert('Error', 'Could not broadcast fuel stop waypoint.');
    }
  }, [groupId]);

  // When disconnected, merge stale (cached) positions for members not in live data
  const liveMemberIds = new Set(Object.keys(memberLocations));
  const staleFallback = Object.values(stalePositions).filter((p) => !liveMemberIds.has(p.userId));
  const members    = [...Object.values(memberLocations), ...staleFallback];
  const rallies    = Array.from(rallyPoints.values());
  const sosPinList = Array.from(sosPins.values());
  const staleMs    = 30_000;

  // Safe-area-aware top offset for floating UI elements
  const topBase = insets.top + 8;

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_DEFAULT}
        style={styles.map}
        mapType={mapStyle}
        showsTraffic
        showsUserLocation
        followsUserLocation
        initialRegion={{ latitude: 37.7749, longitude: -122.4194, latitudeDelta: 0.1, longitudeDelta: 0.1 }}
        onLongPress={handleLongPress}
      >
        {members.map((m: MemberLocation) => (
          <Marker
            key={m.userId}
            coordinate={{ latitude: m.lat, longitude: m.lng }}
            title={m.displayName ?? `Member ${m.userId.slice(0, 6)}`}
            description={m.isStale ? `Last seen ${formatElapsed(m.receivedAt)}` : `${m.speedKph.toFixed(0)} km/h`}
            pinColor="#DC143C"
            opacity={m.isStale ? 0.45 : 1}
          />
        ))}
        {rallies.map((r) => (
          <Marker key={r.id} coordinate={{ latitude: r.lat, longitude: r.lng }} title="Rally Point" description={r.address ?? undefined} pinColor="#22c55e" />
        ))}
        {sosPinList.map((s) => (
          <Marker key={s.id} coordinate={{ latitude: s.lat, longitude: s.lng }} title="SOS" pinColor="#ef4444" />
        ))}
        {routeCoords.length > 0 && (
          <Polyline
            coordinates={routeCoords}
            strokeColor="#DC143C"
            strokeWidth={4}
            lineDashPattern={[1]}
          />
        )}
      </MapView>

      {/* Offline banner — shown when socket is disconnected */}
      {!isConnected && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineBannerText}>Connection lost — showing last known positions</Text>
        </View>
      )}

      {/* Floating search bar — centered top, clears connection badge */}
      <View style={[styles.searchWrapper, { top: topBase }]}>
        <DestinationSearch
          isOnline={isOnline}
          onSelect={handleSearchSelect}
        />
      </View>

      {/* Connection badge — top-right */}
      <View style={[styles.badge, isConnected ? styles.badgeOnline : styles.badgeOffline, { top: topBase }]}>
        <Text style={styles.badgeText}>{isConnected ? 'LIVE' : 'OFFLINE'}</Text>
      </View>

      {/* Re-center — top-left, below safe area */}
      <TouchableOpacity
        style={[styles.recenterBtn, { top: topBase }]}
        onPress={recenter}
        accessibilityLabel="Re-center map"
      >
        <Text style={styles.recenterText}>⊕</Text>
      </TouchableOpacity>

      {/* Speed limit HUD — bottom-left, above member panel */}
      <View style={[styles.speedHudContainer, { bottom: insets.bottom + 236 }]}>
        <SpeedLimitHUD postedLimitKph={null} currentSpeedKph={mySpeedKph} />
      </View>

      {/* Floating action button — bottom-right, above member panel */}
      {user && groupId && (
        <View style={[styles.fabContainer, { bottom: insets.bottom + 228 }]}>
          {fabOpen && (
            <>
              <TouchableOpacity
                style={styles.fabItem}
                onPress={() => { setFabOpen(false); setShowRouteModal(true); }}
                accessibilityLabel="Plan route"
                accessibilityRole="button"
              >
                <Text style={styles.fabItemIcon}>🗺</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.fabItem, drivingModeActive && styles.fabItemActive]}
                onPress={() => { setFabOpen(false); setDrivingModeActive((v) => !v); }}
                accessibilityLabel={drivingModeActive ? 'Exit driving mode' : 'Enter driving mode'}
                accessibilityRole="button"
              >
                <Text style={styles.fabItemIcon}>🚗</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.fabItem}
                onPress={() => { setFabOpen(false); setShowFuelBanner((v) => !v); }}
                accessibilityLabel="Find fuel nearby"
                accessibilityRole="button"
              >
                <Text style={styles.fabItemIcon}>⛽</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.fabItem}
                onPress={() => { setFabOpen(false); setShowHazardPicker(true); }}
                accessibilityLabel="Report a road hazard"
                accessibilityRole="button"
              >
                <Text style={styles.fabItemIcon}>⚠️</Text>
              </TouchableOpacity>
              {mySosId ? (
                <TouchableOpacity
                  style={[styles.fabItem, styles.fabSosCancelItem]}
                  onPress={() => { setFabOpen(false); void cancelMySos(); }}
                  accessibilityLabel="Cancel SOS"
                  accessibilityRole="button"
                >
                  <Text style={styles.fabItemText}>✕ SOS</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[styles.fabItem, styles.fabSosItem]}
                  onPress={() => { setFabOpen(false); handleSosPress(); }}
                  accessibilityLabel="Send SOS emergency alert"
                  accessibilityRole="button"
                >
                  <Text style={styles.fabItemIcon}>🆘</Text>
                </TouchableOpacity>
              )}
              {pttChannelId && (
                <Pressable
                  style={[styles.fabItem, styles.fabPttItem, fabPttActive && styles.fabPttItemActive]}
                  onPressIn={() => { setFabPttActive(true); handlePttStart(); }}
                  onPressOut={() => { setFabPttActive(false); handlePttEnd(); }}
                  accessibilityLabel={fabPttActive ? 'Transmitting — release to stop' : 'Hold for push-to-talk'}
                  accessibilityRole="button"
                >
                  <Text style={styles.fabItemIcon}>🎙</Text>
                  <Text style={styles.fabPttLabel}>{fabPttActive ? 'LIVE' : 'PTT'}</Text>
                </Pressable>
              )}
            </>
          )}
          <TouchableOpacity
            style={[styles.fabMain, fabOpen && styles.fabMainOpen]}
            onPress={() => setFabOpen((v) => !v)}
            accessibilityLabel={fabOpen ? 'Close actions menu' : 'Open actions menu'}
            accessibilityRole="button"
          >
            <Text style={styles.fabMainIcon}>{fabOpen ? '✕' : '⚡'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Fuel suggestion banner — above member panel */}
      {showFuelBanner && myLocation && (
        <View style={styles.fuelBannerWrapper}>
          <FuelSuggestionBanner
            groupId={groupId}
            myLat={myLocation.lat}
            myLng={myLocation.lng}
            isAdmin={isAdmin}
            onSelectStation={handleFuelStationSelect}
            onDismiss={() => setShowFuelBanner(false)}
          />
        </View>
      )}

      {/* Gap alerts */}
      {gapAlerts.length > 0 && (
        <View style={styles.alertBanner}>
          <View style={styles.alertBannerRow}>
            <View style={styles.alertBannerTexts}>
              {gapAlerts.map((a) => (
                <Text key={a.memberId} style={styles.alertText}>
                  ⚠ {memberNamesRef.current[a.memberId] ?? `Member ${a.memberId.slice(0, 6)}`} is {(a.distanceM / 1000).toFixed(1)} km behind
                </Text>
              ))}
            </View>
            <TouchableOpacity
              onPress={() => setGapAlerts([])}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel="Dismiss gap alerts"
            >
              <Text style={styles.alertDismiss}>✕</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Rally alert */}
      {rallyAlert && (
        <TouchableOpacity style={styles.rallyBanner} onPress={() => { Alert.alert('Rally Point', rallyAlert.address ?? `${rallyAlert.lat.toFixed(5)}, ${rallyAlert.lng.toFixed(5)}`); setRallyAlert(null); }}>
          <Text style={styles.rallyBannerText}>🚩 Rally Point set{rallyAlert.address ? `: ${rallyAlert.address}` : ''} — Tap for directions</Text>
        </TouchableOpacity>
      )}

      {/* SOS alerts */}
      {sosAlerts.length > 0 && (
        <View style={[styles.sosBanner, { top: topBase + 60 }]}>
          {sosAlerts.map((a) => <Text key={a.pin.id} style={styles.sosBannerText}>🆘 EMERGENCY — {a.memberName} needs help!</Text>)}
          <TouchableOpacity onPress={() => setSosAlerts([])} accessibilityLabel="Dismiss SOS alerts"><Text style={styles.sosBannerDismiss}>Dismiss</Text></TouchableOpacity>
        </View>
      )}

      {/* Member panel — dark overlay at bottom */}
      <View style={[styles.memberPanel, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <View style={styles.panelHandle} />
        {/* Tab bar */}
        <View style={styles.panelTabRow}>
          <TouchableOpacity
            style={[styles.panelTab, panelTab === 'members' && styles.panelTabActive]}
            onPress={() => setPanelTab('members')}
          >
            <Text style={[styles.panelTabText, panelTab === 'members' && styles.panelTabTextActive]}>
              Members ({members.length})
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.panelTab, panelTab === 'pttlog' && styles.panelTabActive]}
            onPress={() => setPanelTab('pttlog')}
          >
            <Text style={[styles.panelTabText, panelTab === 'pttlog' && styles.panelTabTextActive]}>
              PTT Log
            </Text>
          </TouchableOpacity>
        </View>

        {panelTab === 'pttlog' ? (
          socket
            ? <PTTLogPanel socket={socket} />
            : <View style={styles.panelConnecting}><Text style={styles.emptyText}>Connecting…</Text></View>
        ) : (
        <FlatList
          data={members}
          keyExtractor={(m) => m.userId}
          renderItem={({ item: m }) => {
            const isStale = Date.now() - m.receivedAt > staleMs;
            const memberName = m.displayName ?? `Member ${m.userId.slice(0, 6)}`;
            return (
              <View style={styles.memberRow}>
                <View style={[styles.dot, isStale ? styles.dotOffline : styles.dotOnline]} />
                <Text style={styles.memberText}>{memberName}</Text>
                <Text style={styles.memberDetail}>{isStale ? formatElapsed(m.receivedAt) : `${m.speedKph.toFixed(0)} km/h`}</Text>
                {groupId && (
                  <TouchableOpacity
                    style={styles.rowSosBtn}
                    onPress={() => handlePickSosTarget(memberName, m.lat, m.lng)}
                    accessibilityLabel={`SOS for ${memberName}`}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={styles.rowSosText}>🆘</Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          }}
          ListEmptyComponent={<Text style={styles.emptyText}>No members yet</Text>}
        />
        )}
      </View>

      {/* SOS person picker modal */}
      <Modal transparent visible={showSosPicker} animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, styles.pickerBox]}>
            <Text style={styles.modalTitle}>🆘 SOS — Who needs help?</Text>
            <Text style={styles.pickerSubtitle}>Their current location will be broadcast to all convoy members.</Text>

            {/* Yourself row */}
            <TouchableOpacity
              style={[styles.pickerRow, !myLocation && styles.pickerRowDisabled]}
              disabled={!myLocation}
              onPress={() => handlePickSosTarget('Yourself', myLocation?.lat ?? 0, myLocation?.lng ?? 0)}
            >
              <Text style={styles.pickerRowEmoji}>🙋</Text>
              <View style={styles.pickerRowBody}>
                <Text style={[styles.pickerRowName, !myLocation && styles.pickerRowNameDisabled]}>
                  {myLocation ? 'Yourself' : 'Location unavailable – cannot broadcast'}
                </Text>
                <Text style={styles.pickerRowSub}>{myLocation ? 'Using your GPS location' : 'Enable location permissions to use this option'}</Text>
              </View>
              {myLocation && <Text style={styles.pickerRowArrow}>›</Text>}
            </TouchableOpacity>

            {/* Convoy members */}
            {members.length > 0 && <View style={styles.pickerDivider} />}
            {members.map((m) => {
              const name = m.displayName ?? `Member ${m.userId.slice(0, 6)}`;
              return (
                <TouchableOpacity
                  key={m.userId}
                  style={styles.pickerRow}
                  onPress={() => handlePickSosTarget(name, m.lat, m.lng)}
                >
                  <Text style={styles.pickerRowEmoji}>🚗</Text>
                  <View style={styles.pickerRowBody}>
                    <Text style={styles.pickerRowName}>{name}</Text>
                    <Text style={styles.pickerRowSub}>{m.speedKph.toFixed(0)} km/h · {formatElapsed(m.receivedAt)}</Text>
                  </View>
                  <Text style={styles.pickerRowArrow}>›</Text>
                </TouchableOpacity>
              );
            })}

            <TouchableOpacity
              style={[styles.modalCancel, { marginTop: 16 }]}
              onPress={() => setShowSosPicker(false)}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* SOS confirm modal */}
      <Modal transparent visible={showSosConfirm} animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>🆘 Send SOS Alert?</Text>
            <Text style={styles.modalBody}>
              {pendingSosName ? `This will broadcast ${pendingSosName}'s location` : "This will broadcast your location"} to all convoy members as an emergency alert.
            </Text>
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => { setShowSosConfirm(false); setPendingSosCoord(null); setPendingSosName(''); }}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirm} onPress={confirmSos}>
                <Text style={styles.modalConfirmText}>SEND SOS</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Hazard picker bottom sheet */}
      <HazardPicker
        visible={showHazardPicker}
        isInMotion={mySpeedKph > 5}
        onSelect={handleHazardSelect}
        onClose={() => setShowHazardPicker(false)}
      />

      {/* Route planning modal */}
      <Modal transparent visible={showRouteModal} animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, styles.routeModalBox]}>
            <Text style={styles.modalTitle}>🗺  Plan Route</Text>
            <View style={styles.routeInputRow}>
              <TextInput
                style={styles.routeInput}
                placeholder="Enter destination"
                placeholderTextColor="#555555"
                value={routeDestInput}
                onChangeText={setRouteDestInput}
                returnKeyType="search"
                onSubmitEditing={() => void handleCalculateRoute()}
              />
              <TouchableOpacity
                style={[styles.routeSearchBtn, isCalcRoute && { opacity: 0.5 }]}
                onPress={() => void handleCalculateRoute()}
                disabled={isCalcRoute}
              >
                <Text style={styles.routeSearchBtnText}>{isCalcRoute ? '…' : 'Go'}</Text>
              </TouchableOpacity>
            </View>

            {routeAlternatives.length > 0 && (
              <View style={styles.routeAlts}>
                <Text style={styles.routeAltsLabel}>CHOOSE ROUTE</Text>
                {routeAlternatives.map((alt, idx) => {
                  const km = (alt.distanceM / 1000).toFixed(1);
                  const min = Math.round(alt.durationS / 60);
                  const hrs = Math.floor(min / 60);
                  const remMin = min % 60;
                  const dur = hrs > 0 ? `${hrs}h ${remMin}m` : `${min}m`;
                  return (
                    <TouchableOpacity
                      key={idx}
                      style={[styles.routeAltRow, selectedRouteIdx === idx && styles.routeAltRowActive]}
                      onPress={() => handleSelectRouteAlt(idx)}
                    >
                      <View style={styles.routeAltBody}>
                        <Text style={[styles.routeAltLabel, selectedRouteIdx === idx && styles.routeAltLabelActive]}>
                          Route {idx + 1}
                        </Text>
                        <Text style={styles.routeAltMeta}>{km} km · {dur}</Text>
                      </View>
                      {selectedRouteIdx === idx && <Text style={styles.routeAltCheck}>✓</Text>}
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {routeCoords.length > 0 && routeAlternatives.length > 0 && (
              <TouchableOpacity
                style={styles.routeClearBtn}
                onPress={() => { setRouteCoords([]); setRouteAlternatives([]); setRouteDestInput(''); }}
              >
                <Text style={styles.routeClearText}>Clear Route</Text>
              </TouchableOpacity>
            )}

            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setShowRouteModal(false)}>
                <Text style={styles.modalCancelText}>Close</Text>
              </TouchableOpacity>
              {isAdmin && routeAlternatives.length > 0 && (
                <TouchableOpacity style={styles.modalConfirm} onPress={() => void handlePushRoute()}>
                  <Text style={styles.modalConfirmText}>Push to Group</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>
      </Modal>

      {/* Driving mode overlay — simplified HUD */}
      {drivingModeActive && (
        <View style={styles.drivingOverlay}>
          <View style={styles.drivingSpeedBox}>
            <Text style={styles.drivingSpeedValue}>{Math.round(mySpeedKph)}</Text>
            <Text style={styles.drivingSpeedUnit}>km/h</Text>
          </View>
          <View style={styles.drivingInfo}>
            <Text style={styles.drivingTitle}>DRIVING MODE</Text>
            <Text style={styles.drivingConnected}>{isConnected ? '● LIVE' : '● OFFLINE'}</Text>
          </View>
          <TouchableOpacity
            style={styles.drivingExitBtn}
            onPress={() => setDrivingModeActive(false)}
            accessibilityLabel="Exit driving mode"
          >
            <Text style={styles.drivingExitText}>Exit</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const SEARCH_SIDE_MARGIN = 64; // leaves room for re-center (left) and badge (right)

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { ...StyleSheet.absoluteFillObject },

  // Floating search bar
  searchWrapper: {
    position: 'absolute',
    left: SEARCH_SIDE_MARGIN,
    right: SEARCH_SIDE_MARGIN,
    zIndex: 10,
  },

  // Connection badge — top-right
  badge: {
    position: 'absolute',
    right: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    zIndex: 10,
  },
  badgeOnline: { backgroundColor: '#10b981' },
  badgeOffline: { backgroundColor: '#444444' },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },

  // Re-center — top-left
  recenterBtn: {
    position: 'absolute',
    left: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
    zIndex: 10,
  },
  recenterText: { fontSize: 24 },

  // SOS button — bottom-right (bottom set inline with insets)
  sosContainer: {
    position: 'absolute',
    right: 16,
    alignItems: 'flex-end',
    zIndex: 10,
  },

  // Speed limit HUD — bottom-left
  speedHudContainer: {
    position: 'absolute',
    left: 16,
    zIndex: 10,
  },

  // PTT button — bottom-left, hold to talk
  pttBtn: {
    position: 'absolute',
    left: 16,
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#1C1C1C',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#555555',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
    zIndex: 10,
  },
  pttBtnActive: {
    backgroundColor: '#10b981',
    borderColor: '#fff',
  },
  pttIcon: { fontSize: 22 },
  pttLabel: { color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },

  // Hazard button — bottom-right
  hazardBtn: {
    position: 'absolute',
    right: 16,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#1C1C1C',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#F59E0B',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
    zIndex: 10,
  },
  hazardIcon: { fontSize: 20 },

  // Fuel button — bottom-right
  fuelBtn: {
    position: 'absolute',
    right: 16,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#1C1C1C',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#3b82f6',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
    zIndex: 10,
  },
  fuelIcon: { fontSize: 20 },

  // Fuel banner — above member panel
  fuelBannerWrapper: {
    position: 'absolute',
    bottom: 220,
    left: 0,
    right: 0,
    zIndex: 8,
  },
  sosBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#DC143C',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  sosCancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 44,
    borderRadius: 8,
    backgroundColor: '#555555',
    borderWidth: 2,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sosText: { color: '#fff', fontWeight: '900', fontSize: 13 },

  // Gap / rally / SOS alert banners
  alertBanner: {
    position: 'absolute',
    bottom: 280,
    left: 12,
    right: 12,
    backgroundColor: '#DC143Ccc',
    borderRadius: 8,
    padding: 10,
    zIndex: 8,
  },
  alertBannerRow: { flexDirection: 'row', alignItems: 'flex-start' },
  alertBannerTexts: { flex: 1 },
  alertText: { color: '#fff', fontSize: 13 },
  alertDismiss: { color: '#fff', fontSize: 16, fontWeight: '700', marginLeft: 8, lineHeight: 20 },
  rallyBanner: {
    position: 'absolute',
    bottom: 330,
    left: 12,
    right: 12,
    backgroundColor: '#0D4429dd',
    borderRadius: 8,
    padding: 12,
    zIndex: 8,
  },
  rallyBannerText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  sosBanner: {
    position: 'absolute',
    left: 12,
    right: 80,
    backgroundColor: '#1A0505',
    borderRadius: 8,
    padding: 12,
    borderWidth: 2,
    borderColor: '#FF8080',
    zIndex: 8,
  },
  sosBannerText: { color: '#FF8080', fontSize: 14, fontWeight: '700', marginBottom: 4 },
  sosBannerDismiss: { color: '#FF8080', fontSize: 12, textDecorationLine: 'underline' },

  // Member panel — dark card at bottom
  memberPanel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#0A0A0Aee',
    maxHeight: 220,
    paddingTop: 8,
    paddingHorizontal: 16,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderTopColor: '#2A2A2A',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -2 },
    elevation: 8,
    zIndex: 5,
  },
  panelTabRow: {
    flexDirection: 'row',
    marginBottom: 8,
    borderRadius: 8,
    backgroundColor: '#1A1A1A',
    padding: 2,
  },
  panelTab: {
    flex: 1,
    paddingVertical: 6,
    alignItems: 'center',
    borderRadius: 6,
    minHeight: 30,
    justifyContent: 'center',
  },
  panelTabActive: { backgroundColor: '#DC143C' },
  panelTabText: { color: '#555555', fontSize: 11, fontWeight: '600' },
  panelTabTextActive: { color: '#FFFFFF' },
  panelConnecting: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  panelHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#444444',
    alignSelf: 'center',
    marginBottom: 8,
  },
  panelTitle: { color: '#F0F0F0', fontWeight: '700', marginBottom: 8, fontSize: 13 },
  memberRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, minHeight: 36 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  dotOnline: { backgroundColor: '#10b981' },
  dotOffline: { backgroundColor: '#444444' },
  memberText: { color: '#F0F0F0', flex: 1, fontSize: 13 },
  memberDetail: { color: '#888888', fontSize: 12 },
  emptyText: { color: '#555555', fontSize: 13, textAlign: 'center', marginTop: 8 },

  // SOS confirm modal
  modalOverlay: { flex: 1, backgroundColor: '#00000099', alignItems: 'center', justifyContent: 'center' },
  modalBox: {
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    padding: 24,
    marginHorizontal: 32,
    borderWidth: 2,
    borderColor: '#DC143C',
  },
  modalTitle: { color: '#F0F0F0', fontSize: 20, fontWeight: '800', marginBottom: 12 },
  modalBody: { color: '#888888', fontSize: 14, lineHeight: 20, marginBottom: 20 },
  modalActions: { flexDirection: 'row', gap: 12 },
  modalCancel: { flex: 1, paddingVertical: 12, borderRadius: 8, backgroundColor: '#2A2A2A', alignItems: 'center' },
  modalCancelText: { color: '#F0F0F0', fontWeight: '600' },
  modalConfirm: { flex: 1, paddingVertical: 12, borderRadius: 8, backgroundColor: '#DC143C', alignItems: 'center', borderWidth: 2, borderColor: '#FF8080' },
  modalConfirmText: { color: '#fff', fontWeight: '900', fontSize: 15 },

  // Person picker modal
  pickerBox: { borderColor: '#DC143C', paddingHorizontal: 20, paddingVertical: 24, width: '100%' },
  pickerSubtitle: { color: '#888888', fontSize: 13, lineHeight: 18, marginBottom: 16 },
  pickerDivider: { height: 1, backgroundColor: '#2A2A2A', marginVertical: 8 },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    minHeight: 56,
    borderRadius: 8,
    paddingHorizontal: 4,
  },
  pickerRowEmoji: { fontSize: 24, marginRight: 12 },
  pickerRowBody: { flex: 1 },
  pickerRowName: { color: '#F0F0F0', fontSize: 15, fontWeight: '600' },
  pickerRowNameDisabled: { color: '#555555' },
  pickerRowDisabled: { opacity: 0.5 },
  pickerRowSub: { color: '#555555', fontSize: 12, marginTop: 2 },
  pickerRowArrow: { color: '#444444', fontSize: 22, marginLeft: 8 },

  // Quick SOS on member row
  rowSosBtn: {
    marginLeft: 8,
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowSosText: { fontSize: 18 },

  // FAB — floating action button cluster (bottom-right)
  fabContainer: {
    position: 'absolute',
    right: 16,
    alignItems: 'center',
    zIndex: 10,
  },
  fabMain: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#1C1C1C',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#555555',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 8,
    marginTop: 8,
  },
  fabMainOpen: { borderColor: '#DC143C' },
  fabMainIcon: { fontSize: 26 },
  fabItem: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#1C1C1C',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#555555',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
    marginTop: 8,
  },
  fabItemIcon: { fontSize: 22 },
  fabItemText: { color: '#fff', fontWeight: '800', fontSize: 11 },
  fabItemActive: { borderColor: '#DC143C', backgroundColor: '#1A0505' },
  fabSosItem: { borderColor: '#DC143C' },
  fabSosCancelItem: { borderColor: '#555', backgroundColor: '#3a3a3a' },
  fabPttItem: { borderColor: '#444' },
  fabPttItemActive: { backgroundColor: '#10b981', borderColor: '#fff' },
  fabPttLabel: { color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },

  // Route modal
  routeModalBox: {
    width: '100%',
    maxHeight: '80%',
    borderRadius: 16,
    paddingHorizontal: 20,
    paddingVertical: 24,
    marginHorizontal: 0,
  },
  routeInputRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  routeInput: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    color: '#F0F0F0',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  routeSearchBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  routeSearchBtnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  routeAlts: { marginBottom: 16 },
  routeAltsLabel: { color: '#555555', fontSize: 10, fontWeight: '700', letterSpacing: 1.5, marginBottom: 8 },
  routeAltRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: '#0A0A0A',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    marginBottom: 6,
  },
  routeAltRowActive: { borderColor: '#DC143C', backgroundColor: '#1A0505' },
  routeAltBody: { flex: 1 },
  routeAltLabel: { color: '#888888', fontSize: 14, fontWeight: '600' },
  routeAltLabelActive: { color: '#DC143C' },
  routeAltMeta: { color: '#555555', fontSize: 12, marginTop: 2 },
  routeAltCheck: { color: '#DC143C', fontSize: 18, fontWeight: '900' },
  routeClearBtn: { paddingVertical: 10, alignItems: 'center', marginBottom: 12 },
  routeClearText: { color: '#555555', fontSize: 13, textDecorationLine: 'underline' },

  // Driving mode overlay (bottom bar HUD)
  drivingOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#0A0A0Af5',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderTopWidth: 2,
    borderTopColor: '#DC143C',
    zIndex: 15,
  },
  drivingSpeedBox: {
    alignItems: 'center',
    marginRight: 20,
    minWidth: 64,
  },
  drivingSpeedValue: { color: '#F0F0F0', fontSize: 44, fontWeight: '900', lineHeight: 48 },
  drivingSpeedUnit: { color: '#555555', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  drivingInfo: { flex: 1 },
  drivingTitle: { color: '#DC143C', fontSize: 12, fontWeight: '800', letterSpacing: 2 },
  drivingConnected: { color: '#555555', fontSize: 12, marginTop: 4 },
  drivingExitBtn: {
    backgroundColor: '#1C1C1C',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    minHeight: 40,
    justifyContent: 'center',
  },
  drivingExitText: { color: '#888888', fontWeight: '600', fontSize: 13 },

  // Offline / connection-lost banner
  offlineBanner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: '#B45309',
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignItems: 'center',
    zIndex: 20,
  },
  offlineBannerText: {
    color: '#FFF7ED',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
});
