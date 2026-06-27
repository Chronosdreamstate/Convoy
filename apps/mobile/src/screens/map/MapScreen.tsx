import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  FlatList,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import MapView, { Marker, Callout, Polyline, LongPressEvent, PROVIDER_DEFAULT } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ExpoLocation from 'expo-location';
import { router } from 'expo-router';
import { Socket } from 'socket.io-client';
import { WebSocketService } from '../../services/WebSocketService';
import { useAuthStore } from '../../stores/authStore';
import { useSocketStore } from '../../stores/socketStore';
import { useSettingsStore } from '../../stores/settingsStore';
import PTTLogPanel from '../../components/PTTLogPanel';
import { authService } from '../../services/AuthService';
import { useLocationStore, MemberLocation } from '../../stores/locationStore';
import { useMotionStore } from '../../stores/motionStore';
import { rallyService, RallyPoint, SosPin } from '../../services/RallyService';
import { apiClient } from '../../services/apiClient';
import { HazardType } from '../../services/HazardService';
import DestinationSearch, { SearchResult } from '../../components/DestinationSearch';
import HazardPicker from '../../components/HazardPicker';
import HazardReportModal from '../../components/HazardReportModal';
import SpeedLimitHUD from '../../components/SpeedLimitHUD';
import FuelSuggestionBanner from '../../components/FuelSuggestionBanner';
import GapAlertBanner from '../../components/GapAlertBanner';
import SosAlertModal from '../../components/SosAlertModal';
import ConvoyBanner from '../../components/ConvoyBanner';
import { useGroupStore } from '../../stores/groupStore';
import { SQLiteOfflineDB } from '../../services/OfflineCacheService';
import { MotionStateService } from '../../services/MotionStateService';
import { PTTService } from '../../services/PTTService';
import { agoraEngineAdapter, requestMicPermissionForPTT } from '../../services/AgoraEngineAdapter';
import { apiTokenFetcher } from '../../services/ApiTokenFetcher';
import { DriveService } from '../../services/DriveService';
import { carPlayService } from '../../services/CarPlayService';
import { androidAutoService } from '../../services/AndroidAutoService';
import { HapticService } from '../../services/HapticService';
import { LocationService } from '../../services/LocationService';
import { LiveActivityService } from '../../services/LiveActivityService';
import { useWeather } from '../../hooks/useWeather';

interface GapAlert { memberId: string; distanceM: number }
interface SosAlert { pin: SosPin; memberName: string }
interface HazardPin {
  id: string;
  type: string;
  lat: number;
  lng: number;
  reportedBy?: string;
  reportedAt?: number;
  thumbsUp: number;
  thumbsDown: number;
}

const HAZARD_EMOJI: Record<string, string> = {
  pothole: '🕳️', accident: '🚗', roadwork: '🚧', debris: '🪨',
  animal: '🦌', speed_trap: '📷', ice: '🧊', flood: '🌊', other: '⚠️',
};
function hazardLabel(type: string): string {
  return (type.charAt(0).toUpperCase() + type.slice(1)).replace('_', ' ');
}
function formatTimeAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}
const HAZARD_EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 hours
interface RouteAlternative {
  distance: number;       // metres (matches backend Route shape)
  duration: number;       // seconds
  distanceText: string;
  durationText: string;
  geometry: { type: string; coordinates: [number, number][] };
  speedLimitKph?: number | null;
}

interface Props {
  groupId: string;
  accessToken: string;
  socketUrl: string;
  isAdmin?: boolean;
  pttChannelId?: string;
}

function formatElapsed(receivedAt: number): string {
  const s = Math.floor((Date.now() - receivedAt) / 1000);
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

function memberInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

function haversineDistanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const MemberMarkerView = React.memo(function MemberMarkerView({ member, isStale, distanceM, callsign, gapStatus }: { member: MemberLocation; isStale: boolean; distanceM?: number; callsign?: string; gapStatus?: 'ok' | 'warning' | 'alert' }) {
  const name = member.displayName ?? `M${member.userId.slice(0, 4)}`;
  // Prefer callsign on map markers — more meaningful to car enthusiasts than initials
  const displayLabel = callsign ? callsign.slice(0, 6).toUpperCase() : memberInitials(name).slice(0, 2) || '?';
  const gapDotColor = gapStatus === 'alert' ? '#DC143C' : gapStatus === 'warning' ? '#F59E0B' : '#22C55E';
  const ringScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!isStale) {
      const anim = Animated.loop(
        Animated.sequence([
          Animated.timing(ringScale, { toValue: 1.45, duration: 900, useNativeDriver: true }),
          Animated.timing(ringScale, { toValue: 1, duration: 900, useNativeDriver: true }),
        ]),
      );
      anim.start();
      return () => anim.stop();
    }
  }, [isStale, ringScale]);

  return (
    <View style={{ alignItems: 'center' }}>
      {!isStale && (
        <Animated.View
          style={{
            position: 'absolute',
            width: 40,
            height: 40,
            borderRadius: 20,
            borderWidth: 1.5,
            borderColor: gapDotColor,
            opacity: 0.5,
            transform: [{ scale: ringScale }],
          }}
        />
      )}
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          backgroundColor: '#DC143C',
          borderWidth: 1.5,
          borderColor: isStale ? '#555555' : '#FFFFFF',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: isStale ? 0.45 : 1,
        }}
      >
        <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>{displayLabel}</Text>
      </View>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: isStale ? '#555' : gapDotColor, marginTop: 1 }} />
      <View
        style={{
          marginTop: 2,
          backgroundColor: 'rgba(10,10,10,0.85)',
          borderRadius: 6,
          paddingHorizontal: 5,
          paddingVertical: 2,
          maxWidth: 72,
        }}
      >
        <Text style={{ color: '#FFFFFF', fontSize: 9, fontWeight: '600' }} numberOfLines={1}>
          {callsign ?? name.split(' ')[0]}
        </Text>
        {distanceM != null && (
          <Text style={{ color: gapDotColor, fontSize: 8, fontWeight: '700' }} numberOfLines={1}>
            {distanceM >= 1000 ? `${(distanceM / 1000).toFixed(1)}km` : `${Math.round(distanceM)}m`}
          </Text>
        )}
      </View>
    </View>
  );
});

interface MemberMarkerProps {
  member: MemberLocation;
  myLat: number | null;
  myLng: number | null;
  staleMs: number;
  vehicleMap: React.MutableRefObject<Record<string, string>>;
  callsign?: string;
  gapStatus?: 'ok' | 'warning' | 'alert';
}

const MemberMarker = React.memo(
  function MemberMarker({ member: m, myLat, myLng, staleMs, vehicleMap, callsign, gapStatus }: MemberMarkerProps) {
    const isStale = Date.now() - m.receivedAt > staleMs;
    const vehicle = vehicleMap.current[m.userId];
    const speedLine = isStale ? `Last seen ${formatElapsed(m.receivedAt)}` : `${m.speedKph.toFixed(0)} km/h`;
    const description = vehicle ? `${speedLine} · ${vehicle}` : speedLine;
    const memberName = m.displayName ?? `Member ${m.userId.slice(0, 6)}`;
    const distM = myLat != null && myLng != null
      ? haversineDistanceM(myLat, myLng, m.lat, m.lng)
      : undefined;
    const markerLabel = distM != null
      ? `${callsign ?? memberName}, ${distM >= 1000 ? `${(distM / 1000).toFixed(1)} km away` : `${Math.round(distM)} m away`}`
      : (callsign ?? memberName);
    return (
      <Marker
        coordinate={{ latitude: m.lat, longitude: m.lng }}
        title={callsign ?? memberName}
        description={description}
        anchor={{ x: 0.5, y: 1 }}
        accessibilityLabel={markerLabel}
      >
        <MemberMarkerView member={m} isStale={isStale} distanceM={distM} callsign={callsign} gapStatus={gapStatus} />
      </Marker>
    );
  },
  (prev, next) =>
    prev.member.lat === next.member.lat &&
    prev.member.lng === next.member.lng &&
    prev.member.speedKph === next.member.speedKph &&
    prev.member.receivedAt === next.member.receivedAt &&
    prev.myLat === next.myLat &&
    prev.myLng === next.myLng &&
    prev.callsign === next.callsign &&
    prev.gapStatus === next.gapStatus,
);

const motionStateService = new MotionStateService();

const hapticAdapter = {
  impact: () => HapticService.trigger('medium'),
};

// Module-level SQLite DB instance — init returns a Promise so callers await it
const offlineDB = new SQLiteOfflineDB();
const offlineDBReady: Promise<boolean> = offlineDB.init().then(() => true).catch(() => false);

export default function MapScreen({ groupId, accessToken, socketUrl, isAdmin = false, pttChannelId }: Props) {
  const { user, token } = useAuthStore();
  const { memberLocations, stalePositions, updateMemberLocation, clearGroup, evictStale, setStalePositions, clearStalePositions } = useLocationStore();
  const setIsInMotion = useMotionStore((s) => s.setIsInMotion);
  const groupName = useGroupStore((s) => s.name);
  const groupMemberCount = useGroupStore((s) => s.memberCount);
  const insets = useSafeAreaInsets();

  const [gapAlerts, setGapAlerts]     = useState<GapAlert[]>([]);
  const [hazardPins, setHazardPins]   = useState<Map<string, HazardPin>>(new Map());
  const [hazardAlerts, setHazardAlerts] = useState<HazardPin[]>([]);
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
  const [showHazardModal, setShowHazardModal]     = useState(false);
  const [hazardModalCoords, setHazardModalCoords] = useState<{ lat: number; lng: number } | null>(null);
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
  const [postedSpeedLimitKph, setPostedSpeedLimitKph] = useState<number | null>(null);

  // Dropped pin (Req 5.1–5.4)
  const [droppedPin, setDroppedPin] = useState<{ lat: number; lng: number; address: string | null } | null>(null);

  // Driving mode (manual toggle)
  const [drivingModeActive, setDrivingModeActive] = useState(false);

  // PTT voice availability — tracks Agora engine connection state (Req 43.3)
  const [pttVoiceAvailable, setPttVoiceAvailable] = useState(true);

  // Callsign of the member currently transmitting PTT — used for CarPlay/AndroidAuto waveform
  const [transmittingCallsign, setTransmittingCallsign] = useState<string | null>(null);

  // Reactive socket and settings from shared stores
  const { socket } = useSocketStore();
  const mapStyle = useSettingsStore((s) => s.mapStyle);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const scenicRouting = useSettingsStore((s) => s.scenicRouting);
  const pttMaxSeconds = useSettingsStore((s) => s.pttMaxSeconds);
  const pttVolumePercent = useSettingsStore((s) => s.pttVolumePercent);

  const socketRef       = useRef<Socket | null>(null);
  const mapRef          = useRef<MapView>(null);
  const mySosIdRef      = useRef<string | null>(null);
  const pttServiceRef   = useRef<PTTService | null>(null);
  const micPermGrantedRef = useRef(false); // tracks first PTT permission request (Req 36.6)
  const myLocationRef = useRef<{ lat: number; lng: number } | null>(null); // shadow for callbacks
  const activeDestRef = useRef<{ lat: number; lng: number } | null>(null); // dest of active route
  const memberNamesRef  = useRef<Record<string, string>>({});
  const memberVehiclesRef = useRef<Record<string, string>>({});
  const memberCallsignsRef = useRef<Record<string, string>>({});
  const driveServiceRef = useRef(new DriveService());
  const memberCountRef  = useRef(0);
  const wsServiceRef    = useRef<WebSocketService | null>(null);
  const lastRecvRef     = useRef<Record<string, number>>({}); // throttle incoming per-userId to 800ms

  // Auto-center: fit map to all convoy members; user tap disables
  const [autoCenterAll, setAutoCenterAll] = useState(true);
  const autoCenterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Bottom sheet collapse/expand
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const sheetHeight = useRef(new Animated.Value(80)).current;

  const pttRingScale   = useRef(new Animated.Value(1)).current;
  const pttRingOpacity = useRef(new Animated.Value(0)).current;

  // Quick-action alert toast
  const quickAlertAnim = useRef(new Animated.Value(-60)).current;
  const quickAlertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Admin announcement banner
  const [announcementText, setAnnouncementText] = useState<string | null>(null);
  const announcementAnim = useRef(new Animated.Value(-80)).current;
  const announcementTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [quickAlertText, setQuickAlertText] = useState<string | null>(null);

  // Keep mySosIdRef in sync so the socket handler closure always sees the current value
  useEffect(() => { mySosIdRef.current = mySosId; }, [mySosId]);

  // Animate bottom sheet height between collapsed (80) and expanded (300)
  useEffect(() => {
    Animated.spring(sheetHeight, {
      toValue: sheetExpanded ? 300 : 80,
      useNativeDriver: false,
      damping: 20,
      stiffness: 150,
    }).start();
  }, [sheetExpanded, sheetHeight]);

  // Fit map bounds to all convoy members only when count changes or auto-center re-enabled
  const memberCount = Object.keys(memberLocations).length;
  useEffect(() => {
    if (!autoCenterAll || !groupId) return;
    const memberCoords = Object.values(memberLocations).map((m) => ({
      latitude: m.lat,
      longitude: m.lng,
    }));
    const allCoords = [
      ...(myLocation ? [{ latitude: myLocation.lat, longitude: myLocation.lng }] : []),
      ...memberCoords,
    ];
    if (allCoords.length < 2 || !mapRef.current) return;
    mapRef.current.fitToCoordinates(allCoords, {
      edgePadding: { top: 80, right: 40, bottom: 200, left: 40 },
      animated: true,
    });
  // memberCount gates re-center; myLocation dep intentionally omitted to avoid every GPS tick
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberCount, autoCenterAll, groupId]);

  // Sync CarPlay + AndroidAuto with current convoy state
  useEffect(() => {
    const state = {
      groupId: groupId ?? null,
      memberCount,
      routeActive: routeCoords.length > 0,
      pttChannelId: pttChannelId ?? null,
      myCallsign: user?.pttCallsign ?? '',
      activeGroupName: groupName ?? null,
      nearbyGroupCount: 0,
      convoyStatus: groupId ? 'active' as const : 'idle' as const,
      transmittingMemberCallsign: transmittingCallsign,
      nextWaypointName: null,
      nextWaypointEtaMinutes: null,
      gapToCarAheadM: null,
      speedKph: 0,
      speedLimitKph: null,
      isOverSpeedLimit: false,
      positionInConvoy: 1,
      convoyTotalCars: Object.keys(memberLocations).length + 1,
    };
    if (Platform.OS === 'ios') carPlayService.syncStateIfChanged(state);
    else if (Platform.OS === 'android') androidAutoService.syncStateIfChanged(state);
  }, [groupId, memberLocations, routeCoords.length, pttChannelId, user, groupName, transmittingCallsign]);

  // Pulsing ring animation when actively transmitting PTT
  useEffect(() => {
    if (isPttTransmitting) {
      pttRingScale.setValue(1);
      pttRingOpacity.setValue(0.6);
      const anim = Animated.loop(
        Animated.parallel([
          Animated.sequence([
            Animated.timing(pttRingScale, { toValue: 1.7, duration: 500, useNativeDriver: true }),
            Animated.timing(pttRingScale, { toValue: 1, duration: 0, useNativeDriver: true }),
          ]),
          Animated.sequence([
            Animated.timing(pttRingOpacity, { toValue: 0, duration: 500, useNativeDriver: true }),
            Animated.timing(pttRingOpacity, { toValue: 0.6, duration: 0, useNativeDriver: true }),
          ]),
        ]),
      );
      anim.start();
      return () => anim.stop();
    }
    pttRingOpacity.setValue(0);
  }, [isPttTransmitting, pttRingScale, pttRingOpacity]);

  // Fetch member display names once when group is active so markers and panels show real names
  useEffect(() => {
    if (!groupId || !token) { memberNamesRef.current = {}; return; }
    apiClient
      .get<{ members: Array<{ userId: string; displayName?: string; vehicle?: { year?: number | null; make?: string | null; model?: string | null; color?: string | null } | null }> }>(`/api/v1/groups/${groupId}/members`)
      .then((res) => {
        const names: Record<string, string> = {};
        const vehicles: Record<string, string> = {};
        for (const m of res.data.members) {
          if (m.displayName) names[m.userId] = m.displayName;
          if (m.vehicle) {
            const parts = [m.vehicle.color, m.vehicle.year, m.vehicle.make, m.vehicle.model].filter(Boolean);
            if (parts.length) vehicles[m.userId] = parts.join(' ');
          }
        }
        memberNamesRef.current = names;
        memberVehiclesRef.current = vehicles;
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

  // Track own location via LocationService (supports background tracking when expo-task-manager is added)
  useEffect(() => {
    LocationService.setCallback(({ lat, lng, heading, speedKph, ts }) => {
      const pos = { lat, lng };
      myLocationRef.current = pos;
      setMyLocation(pos);
      setMySpeedKph(speedKph);
      motionStateService.update(speedKph);
      setIsInMotion(motionStateService.state === 'in_motion');
      driveServiceRef.current.addPoint(lat, lng, speedKph);
      wsServiceRef.current?.emitLocation({ lat, lng, heading, speed_kph: speedKph, ts });
    });
    LocationService.startTracking();
    return () => { LocationService.stopTracking(); };
  }, []);

  // PTTService lifecycle — create/destroy when socket or active channel changes
  useEffect(() => {
    if (!socket || !pttChannelId || !groupId) {
      if (pttServiceRef.current) {
        void pttServiceRef.current.leaveChannel();
        pttServiceRef.current = null;
      }
      setPttVoiceAvailable(true);
      return;
    }

    const service = new PTTService(
      agoraEngineAdapter,
      apiTokenFetcher,
      socket,
      hapticAdapter,
    );
    service.setUserVolume(pttVolumePercent);
    pttServiceRef.current = service;
    void service.joinChannel({ groupId, channelId: pttChannelId, maxSeconds: pttMaxSeconds });

    // Poll Agora engine availability every 5s to update "Voice unavailable" indicator (Req 43.3)
    const availabilityPoll = setInterval(() => {
      setPttVoiceAvailable(pttServiceRef.current?.voiceAvailable ?? true);
    }, 5_000);

    return () => {
      clearInterval(availabilityPoll);
      void service.leaveChannel();
      pttServiceRef.current = null;
    };
  // pttVolumePercent intentionally excluded — volume changes are applied reactively below
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, pttChannelId, groupId]);

  // Apply volume preference changes to an already-active PTT session (Req 10.8)
  useEffect(() => {
    pttServiceRef.current?.setUserVolume(pttVolumePercent);
  }, [pttVolumePercent]);

  const showQuickAlert = useCallback((text: string) => {
    if (quickAlertTimerRef.current) clearTimeout(quickAlertTimerRef.current);
    setQuickAlertText(text);
    quickAlertAnim.setValue(-60);
    Animated.spring(quickAlertAnim, { toValue: 0, useNativeDriver: true, damping: 15, stiffness: 200 }).start();
    quickAlertTimerRef.current = setTimeout(() => {
      Animated.timing(quickAlertAnim, { toValue: -60, duration: 300, useNativeDriver: true }).start(
        () => setQuickAlertText(null),
      );
    }, 4000);
  }, [quickAlertAnim]);

  const showAnnouncement = useCallback((text: string) => {
    if (announcementTimerRef.current) clearTimeout(announcementTimerRef.current);
    setAnnouncementText(text);
    announcementAnim.setValue(-80);
    Animated.spring(announcementAnim, { toValue: 0, useNativeDriver: true, damping: 14, stiffness: 180 }).start();
    announcementTimerRef.current = setTimeout(() => {
      Animated.timing(announcementAnim, { toValue: -80, duration: 300, useNativeDriver: true }).start(
        () => setAnnouncementText(null),
      );
    }, 6000);
  }, [announcementAnim]);

  const sendQuickAlert = useCallback((type: string, message: string) => {
    if (!socketRef.current || !groupId) return;
    socketRef.current.emit('convoy:alert', { type, message, groupId });
    showQuickAlert(`You: ${message}`);
  }, [groupId, showQuickAlert]);

  const voteHazard = useCallback((hazardId: string, vote: 'up' | 'down') => {
    if (!socketRef.current || !groupId) return;
    socketRef.current.emit('hazard:vote', { hazardId, vote, groupId });
    setHazardPins((prev) => {
      const m = new Map(prev);
      const h = m.get(hazardId);
      if (!h) return prev;
      m.set(hazardId, {
        ...h,
        thumbsUp: vote === 'up' ? h.thumbsUp + 1 : h.thumbsUp,
        thumbsDown: vote === 'down' ? h.thumbsDown + 1 : h.thumbsDown,
      });
      return m;
    });
  }, [groupId]);

  // Traffic refresh — re-calculate active route every 60 s (Req 6.3)
  useEffect(() => {
    if (routeCoords.length === 0) return;
    const timer = setInterval(async () => {
      const origin = myLocationRef.current;
      const dest = activeDestRef.current;
      if (!origin || !dest) return;
      try {
        const routeBody = { origin, destination: dest, scenic: scenicRouting };
        const routeRes = await apiClient.post<{ routes: RouteAlternative[] }>('/api/v1/routes/calculate', routeBody);
        const alts = routeRes.data.routes;
        if (alts.length > 0) {
          setRouteAlternatives(alts);
          // Preserve selected index (clamped to available routes)
          setSelectedRouteIdx((prev) => {
            const next = Math.min(prev, alts.length - 1);
            const coords = alts[next]?.geometry.coordinates.map(([lng, lat]) => ({ latitude: lat, longitude: lng })) ?? [];
            setRouteCoords(coords);
            setPostedSpeedLimitKph(alts[next]?.speedLimitKph ?? null);
            return next;
          });
        }
      } catch { /* silent — stale route continues to display */ }
    }, 60_000);
    return () => clearInterval(timer);
  // scenicRouting and route selection are accessed via refs; routeCoords.length is the gate
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeCoords.length]);

  // WebSocket
  useEffect(() => {
    if (!token || !groupId) return;
    // Exponential backoff, heartbeat, AppState-aware reconnect, background location throttle (Req 43.2)
    const wsService = new WebSocketService({
      url: socketUrl,
      auth: { token, groupId },
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
    wsServiceRef.current = wsService;
    socketRef.current = socket;
    useSocketStore.getState().setSocket(socket);

    // Forward own logId to PTTService; also track transmitter for CarPlay/AndroidAuto waveform
    socket.on('ptt:transmit', (data: { logId: string; userId: string }) => {
      if (data.userId === user?.id) {
        fabPttLogIdRef.current = data.logId;
        pttServiceRef.current?.setCurrentLogId(data.logId);
      }
      // Show transmitting member's display name in CarPlay waveform banner
      const name = memberNamesRef.current[data.userId] ?? null;
      setTransmittingCallsign(name);
      void LiveActivityService.updateActivity({ transmittingCallsign: name });
    });

    socket.on('ptt:ended', () => {
      setTransmittingCallsign(null);
      void LiveActivityService.updateActivity({ transmittingCallsign: null });
    });

    socket.on('connect', () => {
      setIsConnected(true);
      setIsOnline(true);
      clearStalePositions();
      void LiveActivityService.startActivity({
        groupName: groupId,
        memberCount: 1,
        myPosition: 1,
        totalCars: 1,
        gapToCarAheadM: null,
        transmittingCallsign: null,
        isLeadCar: true,
      });
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
      setIsOnline(false);
      void LiveActivityService.endActivity();
      // Load last-known positions from local cache so the map stays populated
      void offlineDBReady.then((ready) => {
        if (!ready) return;
        return offlineDB.getLastPositions(groupId).then((cached) => {
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
        });
      }).catch(() => {});
    });

    socket.on('location:update', (d: { userId: string; lat: number; lng: number; heading: number; speed_kph: number; ts: number }) => {
      if (d.userId === user?.id) return;
      const now = Date.now();
      if (now - (lastRecvRef.current[d.userId] ?? 0) < 800) return;
      lastRecvRef.current[d.userId] = now;
      const loc: MemberLocation = { userId: d.userId, displayName: memberNamesRef.current[d.userId], lat: d.lat, lng: d.lng, heading: d.heading, speedKph: d.speed_kph, ts: d.ts, receivedAt: now };
      updateMemberLocation(loc);
      // Persist for offline fallback
      void offlineDBReady.then((ready) => {
        if (!ready) return;
        return offlineDB.saveLastPosition({
          userId: d.userId,
          groupId,
          lat: d.lat,
          lng: d.lng,
          heading: d.heading,
          speedKph: d.speed_kph,
          ts: d.ts,
          savedAt: Date.now(),
        });
      }).catch(() => {});
    });

    socket.on('gap:alert', (a: GapAlert) => setGapAlerts((p) => [...p.filter((x) => x.memberId !== a.memberId), a]));

    // Hazard pins: add new reports to the map, alert user on proximity, remove on expiry
    socket.on('hazard:new', (h: Omit<HazardPin, 'thumbsUp' | 'thumbsDown'> & { thumbsUp?: number; thumbsDown?: number }) => {
      const pin: HazardPin = { thumbsUp: 0, thumbsDown: 0, reportedAt: Date.now(), ...h };
      setHazardPins((p) => new Map(p).set(pin.id, pin));
    });
    socket.on('hazard:nearby', (h: Omit<HazardPin, 'thumbsUp' | 'thumbsDown'> & { thumbsUp?: number; thumbsDown?: number }) => {
      const pin: HazardPin = { thumbsUp: 0, thumbsDown: 0, reportedAt: Date.now(), ...h };
      setHazardPins((p) => new Map(p).set(pin.id, pin));
      setHazardAlerts((prev) => prev.some((a) => a.id === pin.id) ? prev : [...prev, pin]);
    });
    socket.on('hazard:vote', ({ hazardId, thumbsUp, thumbsDown }: { hazardId: string; thumbsUp: number; thumbsDown: number }) => {
      setHazardPins((p) => {
        const m = new Map(p);
        const h = m.get(hazardId);
        if (h) m.set(hazardId, { ...h, thumbsUp, thumbsDown });
        return m;
      });
    });
    socket.on('hazard:expired', ({ id }: { id: string }) => {
      setHazardPins((p) => { const n = new Map(p); n.delete(id); return n; });
      setHazardAlerts((prev) => prev.filter((a) => a.id !== id));
    });

    socket.on('route:pushed', (data: { route: { geometry: { coordinates: [number, number][] }; speedLimitKph?: number | null } }) => {
      const coords = data.route.geometry.coordinates.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
      setRouteCoords(coords);
      setPostedSpeedLimitKph(data.route.speedLimitKph ?? null);
      setShowRouteModal(false);
      Alert.alert('Route Updated', 'The group leader pushed a new route to the convoy.');
    });
    socket.on('navigation:arrived', () => {
      Alert.alert('Arrived!', 'You have reached the convoy destination.');
      setPostedSpeedLimitKph(null);
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

    socket.on('convoy:alert', ({ message, senderCallsign }: { message: string; senderCallsign: string }) => {
      showQuickAlert(`${senderCallsign}: ${message}`);
      HapticService.trigger("warning");
    });

    socket.on('group:announcement', ({ message }: { message: string; senderId: string; sentAt: string }) => {
      showAnnouncement(`📢 ${message}`);
      HapticService.trigger("warning");
    });

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
      wsService.disconnect();
      wsServiceRef.current = null;
      useSocketStore.getState().setSocket(null);
      clearGroup();
    };
  }, [token, groupId, socketUrl, updateMemberLocation, user?.id, clearGroup, setStalePositions, clearStalePositions, showAnnouncement]);

  const cycleMapType = useCallback(() => {
    const next = mapStyle === 'standard' ? 'satellite' : mapStyle === 'satellite' ? 'hybrid' : 'standard';
    setSettings({ mapStyle: next });
  }, [mapStyle, setSettings]);

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
    const { latitude: lat, longitude: lng } = e.nativeEvent.coordinate;

    // Drop pin locally (Req 5.1, 5.4 — no server transmission)
    setDroppedPin({ lat, lng, address: null });
    void apiClient.get<{ address: string | null }>('/api/v1/places/reverse', { params: { lat, lng } })
      .then((res) => setDroppedPin((prev) => prev ? { ...prev, address: res.data.address } : prev))
      .catch(() => {});

    const openHazardReport = () => {
      setHazardModalCoords({ lat, lng });
      setShowHazardModal(true);
    };

    if (!groupId) {
      // Outside a group — offer just pin or hazard report
      Alert.alert('Pin Dropped', 'Report a hazard at this location?', [
        { text: 'Just Pin', style: 'cancel' },
        { text: 'Report Hazard', onPress: openHazardReport },
      ]);
      return;
    }

    // In a group — also offer Rally Point broadcast (Req 20.1)
    Alert.alert('Pin Dropped', 'What would you like to do here?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Rally Point',
        onPress: async () => {
          try { await rallyService.broadcastRally(groupId, lat, lng); }
          catch { Alert.alert('Error', 'Could not broadcast rally point.'); }
        },
      },
      { text: 'Report Hazard', onPress: openHazardReport },
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
    HapticService.pttStart();
    // Request mic permission lazily on first PTT attempt (Req 36.6)
    if (!micPermGrantedRef.current) {
      void requestMicPermissionForPTT().then((granted) => {
        micPermGrantedRef.current = granted;
        if (!granted) return;
        setIsPttTransmitting(true);
        if (pttServiceRef.current) {
          pttServiceRef.current.holdStart();
        } else if (socketRef.current && pttChannelId) {
          socketRef.current.emit('ptt:start', { channelId: pttChannelId });
        }
      });
      return;
    }
    setIsPttTransmitting(true);
    if (pttServiceRef.current) {
      pttServiceRef.current.holdStart();
    } else if (socketRef.current && pttChannelId) {
      socketRef.current.emit('ptt:start', { channelId: pttChannelId });
    }
  }, [pttChannelId]);

  const handlePttEnd = useCallback(() => {
    HapticService.pttEnd();
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

      const routeBody = {
        origin: { lat: myLocation.lat, lng: myLocation.lng },
        destination: { lat: dest.lat, lng: dest.lng },
        scenic: scenicRouting,
      };
      let routeRes = await apiClient.post<{ routes: RouteAlternative[] }>('/api/v1/routes/calculate', routeBody);

      // If scenic routing yielded no results, fall back to standard routing (Req 22.4)
      if (scenicRouting && (!routeRes.data.routes?.length)) {
        Alert.alert('Scenic unavailable', 'Scenic routing is not available for this route. Showing standard routes.');
        routeRes = await apiClient.post<{ routes: RouteAlternative[] }>('/api/v1/routes/calculate', {
          ...routeBody,
          scenic: false,
        });
      }

      const alts = routeRes.data.routes;
      setRouteAlternatives(alts);
      setSelectedRouteIdx(0);
      const coords = alts[0]?.geometry.coordinates.map(([lng, lat]) => ({ latitude: lat, longitude: lng })) ?? [];
      setRouteCoords(coords);
      setPostedSpeedLimitKph(alts[0]?.speedLimitKph ?? null);
      activeDestRef.current = dest;
    } catch {
      Alert.alert('Error', 'Could not calculate route.');
    } finally {
      setIsCalcRoute(false);
    }
  }, [myLocation, routeDestInput]);

  const handleSelectRouteAlt = useCallback((idx: number) => {
    setSelectedRouteIdx(idx);
    const alt = routeAlternatives[idx];
    const coords = alt?.geometry.coordinates.map(([lng, lat]) => ({ latitude: lat, longitude: lng })) ?? [];
    setRouteCoords(coords);
    setPostedSpeedLimitKph(alt?.speedLimitKph ?? null);
  }, [routeAlternatives]);

  const handlePushRoute = useCallback(async () => {
    const alt = routeAlternatives[selectedRouteIdx];
    if (!groupId || !alt) return;
    try {
      await apiClient.post(`/api/v1/groups/${groupId}/route`, {
        route: {
          distance: alt.distance,
          duration: alt.duration,
          distanceText: alt.distanceText,
          durationText: alt.durationText,
          geometry: alt.geometry,
        },
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

  const renderMemberRow = useCallback(({ item: m }: { item: MemberLocation }) => {
    const isStale = Date.now() - m.receivedAt > 30_000;
    const memberName = m.displayName ?? `Member ${m.userId.slice(0, 6)}`;
    const callsign = memberCallsignsRef.current[m.userId];
    const gapAlert = gapAlerts.find(a => a.memberId === m.userId);
    const dotColor = isStale ? '#444444' : gapAlert ? (gapAlert.distanceM > 3000 ? '#DC143C' : '#F59E0B') : '#22C55E';
    const distM = myLocation ? haversineDistanceM(myLocation.lat, myLocation.lng, m.lat, m.lng) : null;
    const distLabel = distM != null ? (distM >= 1000 ? `📍 ${(distM / 1000).toFixed(1)} km` : `📍 ${Math.round(distM)} m`) : null;
    const battery = (m as any).batteryPercent as number | undefined;
    return (
      <View style={styles.memberRow}>
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Text style={styles.memberText} numberOfLines={1}>
              {callsign ? `${callsign} · ${memberName}` : memberName}
            </Text>
            {battery != null && battery < 20 && (
              <Text style={{ color: '#DC143C', fontSize: 12 }}>⚡</Text>
            )}
          </View>
          {distLabel && (
            <Text style={{ color: dotColor, fontSize: 11 }} numberOfLines={1}>{distLabel}</Text>
          )}
        </View>
        <Text style={styles.memberDetail}>{isStale ? formatElapsed(m.receivedAt) : `${m.speedKph.toFixed(0)} km/h`}</Text>
        {groupId && (
          <TouchableOpacity
            style={styles.rowSosBtn}
            onPress={() => handlePickSosTarget(memberName, m.lat, m.lng)}
            accessibilityRole="button"
            accessibilityLabel={`SOS for ${memberName}`}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.rowSosText}>🆘</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }, [groupId, handlePickSosTarget, gapAlerts, myLocation]);

  const staleMs = 30_000;

  // When disconnected, merge stale (cached) positions for members not in live data
  const members = useMemo(() => {
    const liveMemberIds = new Set(Object.keys(memberLocations));
    const staleFallback = Object.values(stalePositions).filter((p) => !liveMemberIds.has(p.userId));
    return [...Object.values(memberLocations), ...staleFallback];
  }, [memberLocations, stalePositions]);

  // Sort members by distance from my location (closest first) for easy gap scanning
  const sortedMembers = useMemo(() => {
    if (!myLocation) return members;
    return [...members].sort((a, b) => {
      const da = haversineDistanceM(myLocation.lat, myLocation.lng, a.lat, a.lng);
      const db = haversineDistanceM(myLocation.lat, myLocation.lng, b.lat, b.lng);
      return da - db;
    });
  }, [members, myLocation]);

  const rallies = useMemo(() => Array.from(rallyPoints.values()), [rallyPoints]);
  const sosPinList = useMemo(() => Array.from(sosPins.values()), [sosPins]);

  // Safe-area-aware top offset for floating UI elements
  const topBase = insets.top + 8;

  // Weather data for the HUD pill (non-critical — silently omitted when unavailable)
  const weather = useWeather({ latitude: myLocation?.lat ?? null, longitude: myLocation?.lng ?? null });

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
        onPress={() => { if (autoCenterAll) setAutoCenterAll(false); }}
      >
        {members.map((m: MemberLocation) => {
          const ga = gapAlerts.find(a => a.memberId === m.userId);
          const gapStatus = ga ? (ga.distanceM > 3000 ? 'alert' as const : 'warning' as const) : 'ok' as const;
          return (
            <MemberMarker
              key={m.userId}
              member={m}
              myLat={myLocation?.lat ?? null}
              myLng={myLocation?.lng ?? null}
              staleMs={staleMs}
              vehicleMap={memberVehiclesRef}
              callsign={memberCallsignsRef.current[m.userId]}
              gapStatus={gapStatus}
            />
          );
        })}
        {/* Dropped pin (Req 5.1–5.3) */}
        {droppedPin && (
          <Marker
            coordinate={{ latitude: droppedPin.lat, longitude: droppedPin.lng }}
            title="Dropped Pin"
            description={droppedPin.address ?? 'Loading address…'}
            pinColor="#F59E0B"
            onCalloutPress={() => {
              Alert.alert(
                'Dropped Pin',
                droppedPin.address ?? `${droppedPin.lat.toFixed(5)}, ${droppedPin.lng.toFixed(5)}`,
                [
                  { text: 'Remove Pin', style: 'destructive', onPress: () => setDroppedPin(null) },
                  {
                    text: 'Get Directions',
                    onPress: () => {
                      activeDestRef.current = { lat: droppedPin.lat, lng: droppedPin.lng };
                      void apiClient.post<{ routes: RouteAlternative[] }>('/api/v1/routes/calculate', {
                        origin: myLocationRef.current ?? { lat: droppedPin.lat, lng: droppedPin.lng },
                        destination: { lat: droppedPin.lat, lng: droppedPin.lng },
                        scenic: scenicRouting,
                      }).then((res) => {
                        const alts = res.data.routes;
                        if (alts.length === 0) { Alert.alert('No route found', 'Could not find a route to this pin.'); return; }
                        setRouteAlternatives(alts);
                        setSelectedRouteIdx(0);
                        setRouteCoords(alts[0].geometry.coordinates.map(([lng2, lat2]) => ({ latitude: lat2, longitude: lng2 })));
                        setPostedSpeedLimitKph(alts[0]?.speedLimitKph ?? null);
                      }).catch(() => Alert.alert('Error', 'Could not calculate route.'));
                    },
                  },
                  { text: 'Cancel', style: 'cancel' },
                ],
              );
            }}
          />
        )}
        {rallies.map((r) => (
          <Marker key={r.id} coordinate={{ latitude: r.lat, longitude: r.lng }} title="Rally Point" description={r.address ?? undefined} pinColor="#22c55e" />
        ))}
        {sosPinList.map((s) => (
          <Marker key={s.id} coordinate={{ latitude: s.lat, longitude: s.lng }} title="SOS" pinColor="#DC143C" />
        ))}
        {Array.from(hazardPins.values())
          .filter((h) => !h.reportedAt || Date.now() - h.reportedAt < HAZARD_EXPIRY_MS)
          .map((h) => (
          <Marker
            key={h.id}
            coordinate={{ latitude: h.lat, longitude: h.lng }}
            pinColor="#f59e0b"
          >
            <Callout tooltip onPress={() => {}}>
              <View style={overlayStyles.hazardCallout}>
                <Text style={overlayStyles.hazardCalloutTitle}>
                  {HAZARD_EMOJI[h.type] ?? '⚠️'} {hazardLabel(h.type)}
                </Text>
                {h.reportedBy ? (
                  <Text style={overlayStyles.hazardCalloutSub}>Reported by {h.reportedBy}</Text>
                ) : null}
                {h.reportedAt ? (
                  <Text style={overlayStyles.hazardCalloutSub}>{formatTimeAgo(h.reportedAt)}</Text>
                ) : null}
                <View style={overlayStyles.hazardVoteRow}>
                  <TouchableOpacity
                    style={overlayStyles.hazardVoteBtn}
                    onPress={() => voteHazard(h.id, 'up')}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={overlayStyles.hazardVoteText}>👍 {h.thumbsUp}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={overlayStyles.hazardVoteBtn}
                    onPress={() => voteHazard(h.id, 'down')}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={overlayStyles.hazardVoteText}>👎 {h.thumbsDown}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </Callout>
          </Marker>
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

      {/* Floating search bar — hidden in driving mode (Req 28) */}
      {!drivingModeActive && (
        <View style={[styles.searchWrapper, { top: topBase }]}>
          <DestinationSearch
            isOnline={isOnline}
            isInMotion={mySpeedKph > 5}
            onSelect={handleSearchSelect}
          />
        </View>
      )}

      {/* Connection badge — top-right */}
      <View style={[styles.badge, isConnected ? styles.badgeOnline : styles.badgeOffline, { top: topBase }]}>
        <Text style={styles.badgeText}>{isConnected ? 'LIVE' : 'OFFLINE'}</Text>
      </View>

      {/* Map style cycle button — top-right, below LIVE badge */}
      <TouchableOpacity
        style={[styles.mapTypeBtn, { top: topBase + 40 }]}
        onPress={cycleMapType}
        accessibilityRole="button"
        accessibilityLabel={`Map style: ${mapStyle}. Tap to cycle.`}
      >
        <Text style={{ fontSize: 18 }}>
          {mapStyle === 'standard' ? '🗺️' : mapStyle === 'satellite' ? '🛰️' : '🌍'}
        </Text>
      </TouchableOpacity>

      {/* Re-center — top-left, below safe area */}
      <TouchableOpacity
        style={[styles.recenterBtn, { top: topBase }]}
        onPress={recenter}
        accessibilityRole="button"
        accessibilityLabel="Re-center map"
      >
        <Text style={styles.recenterText}>⊕</Text>
      </TouchableOpacity>

      {/* Auto-center on all convoy members — appears when disabled */}
      {groupId && !autoCenterAll && (
        <TouchableOpacity
          style={[styles.recenterBtn, { top: topBase + 52 }]}
          onPress={() => setAutoCenterAll(true)}
          accessibilityRole="button"
          accessibilityLabel="Re-center map"
        >
          <Text style={styles.recenterText}>🎯</Text>
        </TouchableOpacity>
      )}

      {/* Weather pill — top-left, below re-center / auto-center buttons */}
      {!weather.isLoading && weather.tempC != null && (
        <View style={[styles.weatherPill, { top: topBase + 104 }]}>
          <Text style={styles.weatherPillText}>
            {weather.emoji} {Math.round(weather.tempC)}°C {Math.round(weather.windspeedKmh ?? 0)}km/h
          </Text>
        </View>
      )}

      {/* Speed limit HUD — bottom-left, above member panel (Req 23) */}
      <View style={[styles.speedHudContainer, { bottom: insets.bottom + 96 }]}>
        <SpeedLimitHUD postedLimitKph={postedSpeedLimitKph} currentSpeedKph={mySpeedKph} />
      </View>

      {/* Floating action button — hidden in driving mode (Req 28) */}
      {!drivingModeActive && user && groupId && (
        <View style={[styles.fabContainer, { bottom: insets.bottom + 88 }]}>
          {fabOpen && (
            <>
              <TouchableOpacity
                style={styles.fabItem}
                onPress={() => {
                  setFabOpen(false);
                  if (mySpeedKph > 5) {
                    Alert.alert('Pull Over First', 'Please stop before planning a route.');
                    return;
                  }
                  setShowRouteModal(true);
                }}
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
                onPress={() => { setFabOpen(false); setHazardModalCoords(myLocation); setShowHazardModal(true); }}
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
                  accessibilityLabel="Send SOS alert"
                  accessibilityHint="Alerts your convoy of an emergency"
                  accessibilityRole="button"
                >
                  <Text style={styles.fabItemIcon}>🆘</Text>
                </TouchableOpacity>
              )}
              {pttChannelId && (
                <Pressable
                  style={[
                    styles.fabItem,
                    styles.fabPttItem,
                    fabPttActive && styles.fabPttItemActive,
                    !pttVoiceAvailable && styles.fabPttItemUnavailable,
                  ]}
                  onPressIn={() => { if (pttVoiceAvailable) { setFabPttActive(true); handlePttStart(); } }}
                  onPressOut={() => { setFabPttActive(false); handlePttEnd(); }}
                  accessibilityLabel={
                    !pttVoiceAvailable
                      ? 'Voice unavailable'
                      : fabPttActive
                        ? 'Transmitting voice'
                        : 'Push to Talk'
                  }
                  accessibilityHint="Hold to broadcast voice to convoy"
                  accessibilityRole="button"
                >
                  <Text style={styles.fabItemIcon}>{pttVoiceAvailable ? '🎙' : '🚫'}</Text>
                  <Text style={styles.fabPttLabel}>
                    {!pttVoiceAvailable ? 'NO VOICE' : fabPttActive ? 'LIVE' : 'PTT'}
                  </Text>
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

      {/* Admin announcement banner — slides in from top, crimson */}
      {announcementText != null && (
        <Animated.View
          style={[styles.announcementBanner, { transform: [{ translateY: announcementAnim }] }]}
          accessibilityLiveRegion="polite"
          accessibilityLabel={announcementText}
        >
          <Text style={styles.announcementBannerText} numberOfLines={2}>{announcementText}</Text>
        </Animated.View>
      )}

      {/* Quick-action alert toast — slides in from top */}
      {quickAlertText != null && (
        <Animated.View
          style={[styles.quickAlertBanner, { transform: [{ translateY: quickAlertAnim }] }]}
          accessibilityLiveRegion="polite"
        >
          <Text style={styles.quickAlertText} numberOfLines={1}>{quickAlertText}</Text>
        </Animated.View>
      )}

      {/* Quick-action alert pills — above PTT button, only when in a group */}
      {groupId && pttChannelId && !drivingModeActive && (
        <>
          <View style={[styles.quickActionRow, { bottom: insets.bottom + 228 }]}>
            {([
              { type: 'stopping', label: '🚦 Stopping' },
              { type: 'regroup',  label: '🔄 Regrouping' },
              { type: 'incident', label: '⚠️ Incident' },
            ] as const).map(({ type, label }) => (
              <TouchableOpacity
                key={type}
                style={styles.quickActionPill}
                onPress={() => sendQuickAlert(type, label)}
                accessibilityRole="button"
                accessibilityLabel={`Send ${label} alert to convoy`}
              >
                <Text style={styles.quickActionPillText}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={[styles.quickActionRow, { bottom: insets.bottom + 190 }]}>
            <TouchableOpacity
              style={[styles.quickActionPill, overlayStyles.hazardQuickPill]}
              onPress={() => setShowHazardPicker(true)}
              accessibilityRole="button"
              accessibilityLabel="Report a hazard on the road"
            >
              <Text style={styles.quickActionPillText}>🚨 Report Hazard</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {/* Standalone PTT button — always accessible without opening FAB */}
      {pttChannelId && !drivingModeActive && (
        <View style={[styles.pttStandaloneWrap, { bottom: insets.bottom + 96 }]}>
          {isPttTransmitting && (
            <Animated.View
              style={[
                styles.pttStandaloneRing,
                { transform: [{ scale: pttRingScale }], opacity: pttRingOpacity },
              ]}
            />
          )}
          <Pressable
            style={[
              styles.pttStandaloneBtn,
              isPttTransmitting && styles.pttStandaloneBtnActive,
              !pttVoiceAvailable && styles.pttStandaloneBtnUnavailable,
            ]}
            onPressIn={() => { if (pttVoiceAvailable) { setFabPttActive(true); handlePttStart(); } }}
            onPressOut={() => { setFabPttActive(false); handlePttEnd(); }}
            accessibilityLabel="Push to talk"
            accessibilityHint="Hold to transmit voice to group"
            accessibilityRole="button"
          >
            <Text style={styles.pttStandaloneIcon}>{pttVoiceAvailable ? '🎙' : '🚫'}</Text>
          </Pressable>
          <Text style={[styles.pttStandaloneLabel, isPttTransmitting && styles.pttStandaloneLabelActive]}>
            {!pttVoiceAvailable ? 'NO VOICE' : isPttTransmitting ? 'TRANSMITTING' : 'HOLD TO TALK'}
          </Text>
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

      {/* Gap alerts — use GapAlertBanner for the most recent alert */}
      {gapAlerts.length > 0 && (
        <View accessibilityLiveRegion="polite" accessible={false}>
          <GapAlertBanner
            memberName={memberNamesRef.current[gapAlerts[0].memberId] ?? `Member ${gapAlerts[0].memberId.slice(0, 6)}`}
            distanceM={gapAlerts[0].distanceM}
            thresholdM={2000}
            onDismiss={() => setGapAlerts((p) => p.slice(1))}
          />
        </View>
      )}

      {/* Hazard proximity alerts */}
      {hazardAlerts.length > 0 && (
        <View style={styles.hazardBanner}>
          <View style={styles.hazardBannerStrip} />
          <View style={styles.alertBannerContent}>
            <View style={styles.alertBannerTexts}>
              {hazardAlerts.map((h) => (
                <Text key={h.id} style={styles.hazardAlertText}>
                  {HAZARD_EMOJI[h.type] ?? '⚠️'} {hazardLabel(h.type)} ahead
                </Text>
              ))}
            </View>
            <TouchableOpacity
              onPress={() => setHazardAlerts([])}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Dismiss hazard alerts"
            >
              <Text style={styles.alertDismiss}>✕</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Rally alert */}
      {rallyAlert && (
        <TouchableOpacity
          style={styles.rallyBanner}
          onPress={() => { Alert.alert('Rally Point', rallyAlert.address ?? `${rallyAlert.lat.toFixed(5)}, ${rallyAlert.lng.toFixed(5)}`); setRallyAlert(null); }}
          accessibilityRole="button"
          accessibilityLabel={`Rally Point${rallyAlert.address ? `: ${rallyAlert.address}` : ''} — tap for details`}
        >
          <View style={styles.rallyBannerStrip} />
          <Text style={[styles.rallyBannerText, { flex: 1, padding: 10 }]}>
            🚩 Rally Point set{rallyAlert.address ? `: ${rallyAlert.address}` : ''} — Tap for directions
          </Text>
        </TouchableOpacity>
      )}

      {/* SOS alerts — modal for the first active alert */}
      <SosAlertModal
        visible={sosAlerts.length > 0}
        memberName={sosAlerts[0]?.memberName ?? ''}
        locationLat={sosAlerts[0]?.pin.lat ?? 0}
        locationLng={sosAlerts[0]?.pin.lng ?? 0}
        onNavigate={() => {
          if (sosAlerts[0]) {
            mapRef.current?.animateToRegion({
              latitude: sosAlerts[0].pin.lat,
              longitude: sosAlerts[0].pin.lng,
              latitudeDelta: 0.01,
              longitudeDelta: 0.01,
            }, 800);
          }
          setSosAlerts((p) => p.slice(1));
        }}
        onDismiss={() => setSosAlerts((p) => p.slice(1))}
        onAcknowledge={() => {
          if (socketRef.current && sosAlerts[0]) {
            socketRef.current.emit('sos:acknowledge', { sosId: sosAlerts[0].pin.id, memberName: sosAlerts[0].memberName });
          }
          setSosAlerts((p) => p.slice(1));
        }}
      />

      {/* Member panel — hidden in driving mode (Req 28) */}
      {!drivingModeActive && (
        <Animated.View style={[styles.memberPanel, { height: sheetHeight, paddingBottom: Math.max(insets.bottom, 8), overflow: 'hidden' }]}>
          <TouchableOpacity
            onPress={() => setSheetExpanded((v) => !v)}
            style={{ alignItems: 'center', paddingTop: 4, paddingBottom: 2 }}
            accessibilityRole="button"
            accessibilityLabel="Toggle member list"
          >
            <View style={styles.panelHandle} />
          </TouchableOpacity>

          {!sheetExpanded ? (
            /* Collapsed peek: member count + mini PTT */
            <View style={styles.panelCollapsed}>
              <Text style={styles.panelCollapsedText}>
                🚗 {members.length} {members.length === 1 ? 'rider' : 'riders'}
              </Text>
              {pttChannelId ? (
                <Pressable
                  style={[styles.miniPttBtn, isPttTransmitting && styles.miniPttBtnActive]}
                  onPressIn={() => { if (pttVoiceAvailable) handlePttStart(); }}
                  onPressOut={handlePttEnd}
                  accessibilityLabel="Hold to push to talk"
                  accessibilityRole="button"
                >
                  <Text style={{ fontSize: 16 }}>{isPttTransmitting ? '📡' : '🎙'}</Text>
                </Pressable>
              ) : null}
              <Text style={styles.panelCollapsedChevron}>∧</Text>
            </View>
          ) : (
            <>
              {/* Tab bar */}
              <View style={styles.panelTabRow}>
                <TouchableOpacity
                  style={[styles.panelTab, panelTab === 'members' && styles.panelTabActive]}
                  onPress={() => setPanelTab('members')}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: panelTab === 'members' }}
                  accessibilityLabel={`Members tab, ${members.length} members`}
                >
                  <Text style={[styles.panelTabText, panelTab === 'members' && styles.panelTabTextActive]}>
                    Members ({members.length})
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.panelTab, panelTab === 'pttlog' && styles.panelTabActive]}
                  onPress={() => setPanelTab('pttlog')}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: panelTab === 'pttlog' }}
                  accessibilityLabel="PTT Log tab"
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
                  data={mySpeedKph > 5 ? sortedMembers.slice(0, 4) : sortedMembers}
                  keyExtractor={(m) => m.userId}
                  renderItem={renderMemberRow}
                  removeClippedSubviews
                  ListEmptyComponent={<Text style={styles.emptyText}>No members yet</Text>}
                />
              )}
            </>
          )}
        </Animated.View>
      )}

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
              accessibilityRole="button"
              accessibilityLabel={myLocation ? 'SOS for yourself using your GPS location' : 'Location unavailable'}
              accessibilityState={{ disabled: !myLocation }}
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
                  accessibilityRole="button"
                  accessibilityLabel={`SOS for ${name}`}
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
              accessibilityRole="button"
              accessibilityLabel="Cancel SOS selection"
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
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => { setShowSosConfirm(false); setPendingSosCoord(null); setPendingSosName(''); }}
                accessibilityRole="button"
                accessibilityLabel="Cancel SOS"
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalConfirm}
                onPress={confirmSos}
                accessibilityRole="button"
                accessibilityLabel="Confirm and send SOS emergency alert"
              >
                <Text style={styles.modalConfirmText}>SEND SOS</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Hazard picker bottom sheet (legacy — motion-aware type selection) */}
      <HazardPicker
        visible={showHazardPicker}
        isInMotion={mySpeedKph > 5}
        onSelect={handleHazardSelect}
        onClose={() => setShowHazardPicker(false)}
      />

      {/* Hazard report modal — full form with severity, note, and GPS coords */}
      <HazardReportModal
        visible={showHazardModal}
        onClose={() => setShowHazardModal(false)}
        lat={hazardModalCoords?.lat ?? null}
        lng={hazardModalCoords?.lng ?? null}
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
                accessibilityRole="button"
                accessibilityLabel="Calculate route"
                accessibilityState={{ disabled: isCalcRoute }}
              >
                <Text style={styles.routeSearchBtnText}>{isCalcRoute ? '…' : 'Go'}</Text>
              </TouchableOpacity>
            </View>

            {routeAlternatives.length > 0 && (
              <View style={styles.routeAlts}>
                <Text style={styles.routeAltsLabel}>CHOOSE ROUTE</Text>
                {routeAlternatives.map((alt, idx) => {
                  const km = (alt.distance / 1000).toFixed(1);
                  const min = Math.round(alt.duration / 60);
                  const hrs = Math.floor(min / 60);
                  const remMin = min % 60;
                  const dur = hrs > 0 ? `${hrs}h ${remMin}m` : `${min}m`;
                  return (
                    <TouchableOpacity
                      key={idx}
                      style={[styles.routeAltRow, selectedRouteIdx === idx && styles.routeAltRowActive]}
                      onPress={() => handleSelectRouteAlt(idx)}
                      accessibilityRole="button"
                      accessibilityLabel={`Route ${idx + 1}: ${(alt.distance / 1000).toFixed(1)} km`}
                      accessibilityState={{ selected: selectedRouteIdx === idx }}
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
                onPress={() => { setRouteCoords([]); setRouteAlternatives([]); setRouteDestInput(''); setPostedSpeedLimitKph(null); activeDestRef.current = null; }}
                accessibilityRole="button"
                accessibilityLabel="Clear current route"
              >
                <Text style={styles.routeClearText}>Clear Route</Text>
              </TouchableOpacity>
            )}

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => setShowRouteModal(false)}
                accessibilityRole="button"
                accessibilityLabel="Close route planner"
              >
                <Text style={styles.modalCancelText}>Close</Text>
              </TouchableOpacity>
              {isAdmin && routeAlternatives.length > 0 && (
                <TouchableOpacity
                  style={styles.modalConfirm}
                  onPress={() => void handlePushRoute()}
                  accessibilityRole="button"
                  accessibilityLabel="Push selected route to all group members"
                >
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
            <Text style={styles.drivingSpeedValue} maxFontSizeMultiplier={1.2}>{Math.round(mySpeedKph)}</Text>
            <Text style={styles.drivingSpeedUnit} maxFontSizeMultiplier={1}>km/h</Text>
          </View>
          <View style={styles.drivingInfo}>
            <Text style={styles.drivingTitle} maxFontSizeMultiplier={1.5}>DRIVING MODE</Text>
            <Text style={styles.drivingConnected} maxFontSizeMultiplier={1.5}>{isConnected ? '● LIVE' : '● OFFLINE'}</Text>
          </View>
          <TouchableOpacity
            style={styles.drivingExitBtn}
            onPress={() => setDrivingModeActive(false)}
            accessibilityRole="button"
            accessibilityLabel="Exit driving mode"
          >
            <Text style={styles.drivingExitText}>Exit</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Convoy banner — floating pill showing active group */}
      <ConvoyBanner
        groupName={groupName ?? 'Convoy'}
        memberCount={groupMemberCount}
        isAdmin={isAdmin}
        onPress={() => { /* navigation handled by parent tab */ }}
      />
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
  badgeOnline: { backgroundColor: '#22C55E' },
  badgeOffline: { backgroundColor: '#444444' },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },

  mapTypeBtn: {
    position: 'absolute',
    right: 12,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(28,28,28,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    zIndex: 10,
  },

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

  // Gap / hazard / rally / SOS alert banners
  alertBanner: {
    position: 'absolute',
    bottom: 280,
    left: 12,
    right: 12,
    backgroundColor: '#1C1C1Cee',
    borderRadius: 10,
    flexDirection: 'row',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#DC143C44',
    zIndex: 8,
  },
  alertBannerStrip: {
    width: 4,
    backgroundColor: '#DC143C',
  },
  alertBannerContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 10,
  },
  hazardBanner: {
    position: 'absolute',
    bottom: 320,
    left: 12,
    right: 12,
    backgroundColor: '#1C1C1Cee',
    borderRadius: 10,
    flexDirection: 'row',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#F59E0B44',
    zIndex: 8,
  },
  hazardBannerStrip: {
    width: 4,
    backgroundColor: '#F59E0B',
  },
  hazardAlertText: { color: '#FEF3C7', fontSize: 13 },
  alertBannerTexts: { flex: 1 },
  alertText: { color: '#F0F0F0', fontSize: 13 },
  alertDismiss: { color: '#888888', fontSize: 16, fontWeight: '700', marginLeft: 8, lineHeight: 20 },
  rallyBanner: {
    position: 'absolute',
    bottom: 330,
    left: 12,
    right: 12,
    backgroundColor: '#1C1C1Cee',
    borderRadius: 10,
    flexDirection: 'row',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#22C55E44',
    zIndex: 8,
  },
  rallyBannerStrip: {
    width: 4,
    backgroundColor: '#22C55E',
  },
  rallyBannerText: { color: '#F0F0F0', fontSize: 13, fontWeight: '600' },
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

  // Member panel — glass-morphism bottom sheet
  memberPanel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(10, 10, 10, 0.92)',
    overflow: 'hidden',
    paddingTop: 4,
    paddingHorizontal: 16,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.08)',
    shadowColor: '#000',
    shadowOpacity: 0.6,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: -4 },
    elevation: 12,
    zIndex: 5,
  },
  panelCollapsed: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingVertical: 8,
    gap: 12,
  },
  panelCollapsedText: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  panelCollapsedChevron: {
    color: '#888888',
    fontSize: 18,
    fontWeight: '600',
  },
  miniPttBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#1C1C1C',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniPttBtnActive: {
    backgroundColor: 'rgba(220, 20, 60, 0.25)',
    borderColor: '#DC143C',
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
  dotOnline: { backgroundColor: '#22C55E' },
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
  fabPttItem: { borderColor: '#DC143C' },
  fabPttItemActive: { backgroundColor: '#8B0000', borderColor: '#FF4040' },
  fabPttItemUnavailable: { backgroundColor: '#2A2A2A', borderColor: '#555', opacity: 0.6 },
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
    backgroundColor: 'rgba(28, 28, 28, 0.94)',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
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

  // Standalone PTT button — bottom-center, always visible when voice is available
  pttStandaloneWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10,
  },
  pttStandaloneRing: {
    position: 'absolute',
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 2.5,
    borderColor: '#DC143C',
  },
  pttStandaloneBtn: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#1C1C1C',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#DC143C',
    shadowColor: '#DC143C',
    shadowOpacity: 0.45,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 10,
  },
  pttStandaloneBtnActive: {
    backgroundColor: '#8B0000',
    borderColor: '#FF4040',
    shadowOpacity: 0.9,
  },
  pttStandaloneBtnUnavailable: {
    borderColor: '#555555',
    opacity: 0.5,
    shadowOpacity: 0,
  },
  pttStandaloneIcon: { fontSize: 30 },
  pttStandaloneLabel: {
    color: '#555555',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.5,
    marginTop: 6,
  },
  pttStandaloneLabelActive: {
    color: '#FF4040',
  },

  // Quick-action alert toast
  quickAlertBanner: {
    position: 'absolute',
    top: 0,
    left: 16,
    right: 16,
    backgroundColor: '#1C1C1C',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#F59E0B44',
    borderLeftWidth: 4,
    borderLeftColor: '#F59E0B',
    zIndex: 25,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 12,
  },
  quickAlertText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },

  announcementBanner: {
    position: 'absolute',
    top: 0,
    left: 16,
    right: 16,
    backgroundColor: '#DC143C',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    zIndex: 26,
    shadowColor: '#DC143C',
    shadowOpacity: 0.6,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 14,
  },
  announcementBannerText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 20,
  },

  // Quick-action pill row
  quickActionRow: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    gap: 8,
    zIndex: 10,
  },
  quickActionPill: {
    flex: 1,
    height: 36,
    backgroundColor: '#1C1C1C',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  quickActionPillText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },

  // Weather pill — top-left overlay
  weatherPill: {
    position: 'absolute',
    left: 12,
    backgroundColor: '#1C1C1C',
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    zIndex: 10,
  },
  weatherPillText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
});

const overlayStyles = StyleSheet.create({
  hazardCallout: {
    backgroundColor: '#1C1C1C',
    borderRadius: 10,
    padding: 12,
    minWidth: 160,
    borderWidth: 1,
    borderColor: '#F59E0B44',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 8,
  },
  hazardCalloutTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 4,
  },
  hazardCalloutSub: {
    color: '#888888',
    fontSize: 11,
    marginBottom: 2,
  },
  hazardVoteRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#2A2A2A',
  },
  hazardVoteBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#0A0A0A',
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  hazardVoteText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  hazardQuickPill: {
    borderColor: '#F59E0B',
    backgroundColor: '#1C1000',
    flex: 1,
  },
});
