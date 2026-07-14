import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import MapView, { Marker, Callout, LongPressEvent, Region, PROVIDER_DEFAULT } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Socket } from 'socket.io-client';
import { Ionicons, MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
import { ThemeColors, useTheme } from '../../theme';
import { WebSocketService } from '../../services/WebSocketService';
import { useAuthStore } from '../../stores/authStore';
import { useSocketStore } from '../../stores/socketStore';
import { useSettingsStore } from '../../stores/settingsStore';
import PTTLogPanel from '../../components/PTTLogPanel';
import { authService } from '../../services/AuthService';
import { useLocationStore, MemberLocation } from '../../stores/locationStore';
import { rallyService, RallyPoint, SosPin } from '../../services/RallyService';
import { apiClient } from '../../services/apiClient';
import { HazardService, HazardType, IHazardApiClient } from '../../services/HazardService';
import DestinationSearch, { SearchResult } from '../../components/DestinationSearch';
import HazardPicker from '../../components/HazardPicker';
import HazardReportModal from '../../components/HazardReportModal';
import SpeedLimitHUD from '../../components/SpeedLimitHUD';
import FuelSuggestionBanner from '../../components/FuelSuggestionBanner';
import GapAlertBanner from '../../components/GapAlertBanner';
import SosAlertModal from '../../components/SosAlertModal';
import ConvoyBanner from '../../components/ConvoyBanner';
import CoachMarkOverlay from '../../components/CoachMarkOverlay';
import ScenicRouteSelector, { RouteOption } from '../../components/ScenicRouteSelector';
import * as SecureStore from 'expo-secure-store';
import { useGroupStore } from '../../stores/groupStore';
import { SQLiteOfflineDB, computeBoundsWithBuffer } from '../../services/OfflineCacheService';
import { connectivityService } from '../../services/ConnectivityService';
import { CongestionLevel, CongestionTier, congestionTierSegments, applyFuelStopWaypoint } from '../../services/RouteService';
import CongestionRoutePolyline from '../../components/map/CongestionRoutePolyline';
import MapDataUnavailableBadge, { CachedTileBounds, regionHasCachedMapData } from '../../components/map/MapDataUnavailableBadge';
import { deriveMotionState } from '../../services/MotionStateService';
import { PTTService } from '../../services/PTTService';
import { agoraEngineAdapter, requestMicPermissionForPTT } from '../../services/AgoraEngineAdapter';
import { apiTokenFetcher } from '../../services/ApiTokenFetcher';
import { driveService, buildConvoyEndParams } from '../../services/DriveService';
import { haversineDistanceM } from '../../utils/geo';
import { carPlayService } from '../../services/CarPlayService';
import { androidAutoService } from '../../services/AndroidAutoService';
import { DrivingModeService, IBluetoothProvider } from '../../services/DrivingModeService';
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

// Hazard-type glyphs on map pins/callouts/banners are deliberately kept as emoji —
// they need to be recognized at a glance on a small map marker, and matching
// HazardPicker's emoji set keeps the reporting UI and the resulting pin consistent.
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
/** Formats a distance in meters for display on hazard pins (Req 11.4). */
function formatDistance(distM: number): string {
  return distM >= 1000 ? `${(distM / 1000).toFixed(1)} km` : `${Math.round(distM)} m`;
}
// Must match the server's expiry window (hazards.routes.ts HAZARD_EXPIRY_MS, Req 11.3)
// so pins disappear from the map around the same time the server stops treating
// the report as active. This previously drifted to 2 hours, leaving expired
// hazards visible on other members' maps for far longer than intended.
const HAZARD_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

// Stub IBluetoothProvider — no native plain-Bluetooth (non-CarPlay/Android Auto) vehicle
// connection module exists in this codebase yet. Always reports "not connected" so
// DrivingModeService's auto-detection currently only reacts to CarPlay/Android Auto
// sessions; wiring real vehicle BT audio detection is a separate, out-of-scope task.
const noopBluetoothProvider: IBluetoothProvider = {
  onVehicleConnectionChange: () => () => {},
};

// Must match CoachMarkOverlay's own STORAGE_KEY — that component only *writes*
// this flag (when the user finishes/skips the walkthrough), so MapScreen is
// responsible for reading it to decide whether to show the tour on this mount.
const COACH_MARKS_STORAGE_KEY = 'coach_marks_shown';
interface RouteAlternative {
  distance: number;       // metres (matches backend Route shape)
  duration: number;       // seconds
  distanceText: string;
  durationText: string;
  geometry: { type: string; coordinates: [number, number][] };
  speedLimitKph?: number | null;
  /** Per-segment posted speed limit (kph), aligned to geometry.coordinates (Req 23.1, 23.2). */
  speedLimitSegmentsKph?: (number | null)[];
  /** Per-segment traffic congestion, aligned the same way (Req 6.2). */
  congestionSegments?: CongestionLevel[];
}

/**
 * Per-segment congestion tiers for a route alternative (Req 6.2), aligned so
 * entry i colors coordinates[i]→coordinates[i+1]. Thin adapter over
 * RouteService's congestionTierSegments — RouteAlternative types its geometry
 * as `{ type: string }` (backend shape) rather than the literal 'LineString'
 * that helper expects. Exported for tests.
 */
export function tiersForAlternative(
  alt: Pick<RouteAlternative, 'geometry' | 'congestionSegments'> | undefined,
): (CongestionTier | null)[] {
  if (!alt) return [];
  return congestionTierSegments({
    geometry: { type: 'LineString', coordinates: alt.geometry.coordinates },
    congestionSegments: alt.congestionSegments,
  });
}

// Must match OfflineCacheService's (non-exported) TILE_BUFFER_MILES: the map
// data considered "cached" for the Req 4.4 indicator is exactly the corridor
// Req 4.1's prefetch covers — the active route plus this buffer.
const CACHED_TILE_BUFFER_MILES = 10;

/** Index of the coordinate segment nearest (lat, lng) along a route polyline. */
function nearestSegmentIndex(
  lat: number,
  lng: number,
  coords: Array<{ latitude: number; longitude: number }>,
): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const dLat = coords[i].latitude - lat;
    const dLng = coords[i].longitude - lng;
    const d = dLat * dLat + dLng * dLng; // squared degrees — good enough for nearest-point ranking
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}

interface Props {
  groupId: string;
  socketUrl: string;
  isAdmin?: boolean;
  pttChannelId?: string;
}

/**
 * Reference point for member-list distances (Req 8.4): the spec measures each
 * Member's "estimated distance" from the ADMIN's position, not from the viewing
 * user. Resolution order:
 *   1. the caller IS the admin → their own live GPS fix,
 *   2. the admin is another member with a known position → that position,
 *   3. admin position unknown (adminId not loaded yet, or the admin hasn't
 *      reported a location) → fall back to the caller's own position. A
 *      caller-relative distance is still meaningful for gap scanning (and is
 *      exactly the pre-fix behavior), unlike a dash which drops information.
 * Returns null only when no reference point exists at all. Exported for tests.
 */
export function resolveDistanceOrigin(
  adminId: string | null,
  myUserId: string | null | undefined,
  myLocation: { lat: number; lng: number } | null,
  members: ReadonlyArray<{ userId: string; lat: number; lng: number }>,
): { lat: number; lng: number } | null {
  if (adminId) {
    if (adminId === myUserId && myLocation) return myLocation;
    const admin = members.find((m) => m.userId === adminId);
    if (admin) return { lat: admin.lat, lng: admin.lng };
  }
  return myLocation;
}

/**
 * Broadcasts an SOS via the channel that matches the user's convoy state:
 * the group endpoint when a convoy is active (Req 25.3), otherwise the
 * standalone endpoint that alerts friends with location sharing (Req 25.7).
 * Exported for tests.
 */
export function broadcastSosPin(
  svc: Pick<typeof rallyService, 'broadcastGroupSos' | 'broadcastStandaloneSos'>,
  groupId: string | null | undefined,
  coord: { lat: number; lng: number },
): Promise<SosPin> {
  return groupId
    ? svc.broadcastGroupSos(groupId, coord.lat, coord.lng)
    : svc.broadcastStandaloneSos(coord.lat, coord.lng);
}

/** Cancels an SOS via the matching channel (group Req 25.6 / standalone Req 25.7). */
export function cancelSosPin(
  svc: Pick<typeof rallyService, 'cancelSos' | 'cancelStandaloneSos'>,
  groupId: string | null | undefined,
  sosId: string,
): Promise<void> {
  return groupId ? svc.cancelSos(groupId, sosId) : svc.cancelStandaloneSos(sosId);
}

function formatElapsed(receivedAt: number): string {
  const s = Math.floor((Date.now() - receivedAt) / 1000);
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

// Hoisted so the quick-action pill row doesn't rebuild this array on every
// render — MapScreen re-renders on every GPS tick.
const QUICK_ACTIONS = [
  { type: 'stopping', label: 'Stopping', message: '🚦 Stopping', icon: 'hand-left' as const },
  { type: 'regroup',  label: 'Regrouping', message: '🔄 Regrouping', icon: 'sync' as const },
  { type: 'incident', label: 'Incident', message: '⚠️ Incident', icon: 'warning' as const },
];

// Stable identities for FlatList / ConvoyBanner props — inline versions would be
// recreated on every GPS-tick render and defeat those children's memoization.
const memberKeyExtractor = (m: MemberLocation) => m.userId;
const noopBannerPress = () => { /* navigation handled by parent tab */ };

function memberInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

const MemberMarkerView = React.memo(function MemberMarkerView({ member, isStale, distanceM, callsign, gapStatus }: { member: MemberLocation; isStale: boolean; distanceM?: number; callsign?: string; gapStatus?: 'ok' | 'warning' | 'alert' }) {
  const { colors } = useTheme();
  const name = member.displayName ?? `M${member.userId.slice(0, 4)}`;
  // Prefer callsign on map markers — more meaningful to car enthusiasts than initials
  const displayLabel = callsign ? callsign.slice(0, 6).toUpperCase() : memberInitials(name).slice(0, 2) || '?';
  // Status color is themed (matches the app's semantic accent/warning/success tokens);
  // the badge's white ring/text below stay hardcoded on purpose — they need fixed
  // contrast against this marker's own crimson fill as it floats over map imagery,
  // not the app's light/dark surface.
  const gapDotColor = gapStatus === 'alert' ? colors.accent : gapStatus === 'warning' ? colors.warning : colors.success;
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
      {/* Directional heading indicator (Req 8.3) — a chevron that orbits the badge,
          rotated to the member's GPS heading (degrees clockwise from true north). */}
      {!isStale && (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: 32,
            height: 32,
            alignItems: 'center',
            transform: [{ rotate: `${member.heading}deg` }],
          }}
        >
          <View
            style={{
              width: 0,
              height: 0,
              marginTop: -5,
              borderLeftWidth: 5,
              borderRightWidth: 5,
              borderBottomWidth: 7,
              borderLeftColor: 'transparent',
              borderRightColor: 'transparent',
              borderBottomColor: '#FFFFFF',
            }}
          />
        </View>
      )}
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          backgroundColor: colors.accent,
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
    // heading/displayName are rendered (chevron rotation, marker label) and can
    // change on an update that leaves lat/lng identical — without these checks
    // the memo held stale output in that case.
    prev.member.heading === next.member.heading &&
    prev.member.displayName === next.member.displayName &&
    prev.member.speedKph === next.member.speedKph &&
    prev.member.receivedAt === next.member.receivedAt &&
    prev.myLat === next.myLat &&
    prev.myLng === next.myLng &&
    prev.callsign === next.callsign &&
    prev.gapStatus === next.gapStatus,
);

const hapticAdapter = {
  impact: () => HapticService.trigger('medium'),
};

// Module-level SQLite DB instance — init returns a Promise so callers await it
const offlineDB = new SQLiteOfflineDB();
const offlineDBReady: Promise<boolean> = offlineDB.init().then(() => true).catch(() => false);

// HazardService — queues hazard reports in the offline cache when the create
// call fails (offline or network error), so they can be flushed via
// POST /hazards/bulk once connectivity returns (Req 11.9, 11.10).
const hazardApiClient: IHazardApiClient = {
  createHazard: (type, lat, lng) =>
    apiClient.post('/api/v1/hazards', { type, lat, lng }).then((r) => r.data),
  confirmHazard: (id) => apiClient.post(`/api/v1/hazards/${id}/confirm`).then(() => undefined),
  dismissHazard: (id) => apiClient.post(`/api/v1/hazards/${id}/dismiss`).then(() => undefined),
};
const hazardService = new HazardService(
  hazardApiClient,
  { saveOfflineHazard: (h) => offlineDB.saveHazard(h) },
  () => true, // always attempt the network call; failures fall back to the offline queue below
);

/** Flushes any hazard reports queued while offline (Req 11.9, 11.10). Safe to call repeatedly. */
async function flushOfflineHazards(): Promise<void> {
  const ready = await offlineDBReady;
  if (!ready) return;
  const pending = await offlineDB.getPendingHazards();
  if (pending.length === 0) return;
  try {
    await apiClient.post('/api/v1/hazards/bulk', {
      hazards: pending.map((h) => ({ type: h.type, lat: h.lat, lng: h.lng, createdAt: h.createdAt })),
    });
    await offlineDB.clearHazards(pending.map((h) => h.id));
  } catch {
    // Still offline or server rejected the batch — retry on the next reconnect.
  }
}

export default function MapScreen({ groupId, socketUrl, isAdmin = false, pttChannelId }: Props) {
  // Per-slice selectors — subscribing to the whole store re-rendered this
  // (very hot) screen on unrelated store changes, e.g. authStore.isLoading
  // flips or locationStore.myLocation writes from other screens.
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const memberLocations = useLocationStore((s) => s.memberLocations);
  const stalePositions = useLocationStore((s) => s.stalePositions);
  const updateMemberLocation = useLocationStore((s) => s.updateMemberLocation);
  const clearGroup = useLocationStore((s) => s.clearGroup);
  const evictStale = useLocationStore((s) => s.evictStale);
  const setStalePositions = useLocationStore((s) => s.setStalePositions);
  const clearStalePositions = useLocationStore((s) => s.clearStalePositions);
  const groupName = useGroupStore((s) => s.name);
  const groupAdminId = useGroupStore((s) => s.adminId);
  const groupMemberCount = useGroupStore((s) => s.memberCount);
  const gapThresholdM = useGroupStore((s) => s.gapThresholdM);
  const groupPttMaxSeconds = useGroupStore((s) => s.pttMaxSeconds);
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const overlayStyles = useMemo(() => makeOverlayStyles(colors), [colors]);

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
  // Per-segment congestion tiers for the active route line (Req 6.2), aligned
  // to routeCoords — set together with it at every route-change site.
  const [routeCongestionTiers, setRouteCongestionTiers] = useState<(CongestionTier | null)[]>([]);
  const [routeAlternatives, setRouteAlternatives] = useState<RouteAlternative[]>([]);
  const [selectedRouteIdx, setSelectedRouteIdx]   = useState<number>(0);
  const [showRouteModal, setShowRouteModal]       = useState(false);
  const [routeDestInput, setRouteDestInput]       = useState('');
  const [isCalcRoute, setIsCalcRoute]             = useState(false);
  const [postedSpeedLimitKph, setPostedSpeedLimitKph] = useState<number | null>(null);
  // Scenic-vs-fastest route picker sheet — offered after picking a destination
  // from the top search bar (Req 22.3's "present scenic as default, standard as
  // alternate" applies just as much when the user is choosing, not just viewing).
  const [showScenicSelector, setShowScenicSelector] = useState(false);

  // First-visit spotlight tutorial (PTT / member list / hazard report). Visibility
  // is decided by MapScreen (below) by reading CoachMarkOverlay's own "seen" flag;
  // the component itself only writes that flag once the user finishes or skips.
  const [showCoachMarks, setShowCoachMarks] = useState(false);

  // Dropped pin (Req 5.1–5.4)
  const [droppedPin, setDroppedPin] = useState<{ lat: number; lng: number; address: string | null } | null>(null);

  // Req 4.4 — "map data unavailable" indicator: true while the device is
  // offline AND the viewed region isn't covered by the cached tile corridor.
  // Inputs live in refs (updated by connectivity events / region-change events
  // / route changes) so online panning never writes state — only the derived
  // boolean does, and setState with an unchanged boolean doesn't re-render.
  const [mapDataUnavailable, setMapDataUnavailable] = useState(false);
  const viewedRegionRef = useRef<Region | null>(null);
  const apiReachableRef = useRef(true);
  const cachedTileBoundsRef = useRef<CachedTileBounds | null>(null);

  // Driving mode — auto-activated on CarPlay/Android Auto (and, once implemented, plain
  // Bluetooth) connect, with manual override support (Req 28.1, 28.4–28.6).
  const [drivingModeActive, setDrivingModeActive] = useState(false);
  const drivingModeServiceRef = useRef<DrivingModeService | null>(null);

  // PTT voice availability — tracks Agora engine connection state (Req 43.3)
  const [pttVoiceAvailable, setPttVoiceAvailable] = useState(true);

  // Set true when the Admin mutes this member's PTT (Req 10.11) — disables the
  // hold-to-talk controls locally since Agora audio never routes through this backend.
  const [pttAdminMuted, setPttAdminMuted] = useState(false);

  // Callsign of the member currently transmitting PTT — used for CarPlay/AndroidAuto waveform
  const [transmittingCallsign, setTransmittingCallsign] = useState<string | null>(null);

  // Reactive socket and settings from shared stores. Selecting only `socket`
  // matters here: the whole-store subscription used previously re-rendered
  // MapScreen on every presence update (onlineUserIds/lastSeenMap are rebuilt
  // per member:online/offline/presence:update event), none of which this
  // screen displays.
  const socket = useSocketStore((s) => s.socket);
  const mapStyle = useSettingsStore((s) => s.mapStyle);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const scenicRouting = useSettingsStore((s) => s.scenicRouting);
  const distanceUnit = useSettingsStore((s) => s.distanceUnit);
  const pttVolumePercent = useSettingsStore((s) => s.pttVolumePercent);

  const socketRef       = useRef<Socket | null>(null);
  const mapRef          = useRef<MapView>(null);
  const mySosIdRef      = useRef<string | null>(null);
  const pttServiceRef   = useRef<PTTService | null>(null);
  const micPermGrantedRef = useRef(false); // tracks first PTT permission request (Req 36.6)
  // True only while the user's finger is actually down on a PTT button. The very first
  // PTT press awaits an async mic-permission prompt before it may start transmitting;
  // without this guard, a quick tap-and-release during that wait let the permission
  // promise resolve *after* handlePttEnd had already fired, so holdStart()/setIsPttTransmitting(true)
  // ran anyway — silently starting a mic transmission the user had already released.
  const pttPressActiveRef = useRef(false);
  const myLocationRef = useRef<{ lat: number; lng: number } | null>(null); // shadow for callbacks
  const activeDestRef = useRef<{ lat: number; lng: number } | null>(null); // dest of active route
  // Active route's polyline + per-segment speed limits, used to look up the limit
  // for the segment nearest the driver's live position (Req 23.1, 23.2).
  const activeRouteSegmentsRef = useRef<{ coords: Array<{ latitude: number; longitude: number }>; segmentsKph: (number | null)[] }>({ coords: [], segmentsKph: [] });
  const memberNamesRef  = useRef<Record<string, string>>({});
  const memberVehiclesRef = useRef<Record<string, string>>({});
  const memberCallsignsRef = useRef<Record<string, string>>({});
  // Shared app-wide instance (not per-screen): ConvoyScreen's Admin end-convoy
  // flow reads the same session (peekStats / claimEndNavigation), so exactly
  // one of the two end-of-drive paths navigates to /convoy-end.
  const driveServiceRef = useRef(driveService);
  const fuelSuggestionShownRef = useRef(false); // fires at most once per session (Req 21.1)
  const memberCountRef  = useRef(0);
  const wsServiceRef    = useRef<WebSocketService | null>(null);
  const lastRecvRef     = useRef<Record<string, number>>({}); // throttle incoming per-userId to 800ms
  // Set once the first GPS-fix-triggered hazard/rally backfill has fired, so the
  // location callback (which runs on every GPS tick) doesn't refetch repeatedly.
  const initialBackfillDoneRef = useRef(false);

  // Auto-center: fit map to all convoy members; user tap disables
  const [autoCenterAll, setAutoCenterAll] = useState(true);

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

  // showQuickAlert/showAnnouncement schedule a setTimeout to auto-dismiss their toast
  // (4s / 6s respectively). Without this, navigating away from MapScreen while one of
  // those timers is still pending (e.g. leaving the group right after a quick alert
  // fires) leaves the timer running and calls setQuickAlertText/setAnnouncementText on
  // an unmounted component once it fires.
  useEffect(() => {
    return () => {
      if (quickAlertTimerRef.current) clearTimeout(quickAlertTimerRef.current);
      if (announcementTimerRef.current) clearTimeout(announcementTimerRef.current);
    };
  }, []);

  // Flush any hazard reports queued offline (Req 11.9, 11.10). Runs once on mount so
  // users outside a group (no socket connection) still get their queue drained; the
  // socket 'connect' handler below covers the in-group reconnect case too.
  useEffect(() => { void flushOfflineHazards(); }, []);

  // Show the first-visit spotlight tutorial once per install: read the "seen" flag
  // CoachMarkOverlay itself writes on completion/skip, and only reveal the overlay
  // when it's absent. Runs once on mount, same as the offline-hazard flush above.
  useEffect(() => {
    (async () => {
      try {
        const seen = await SecureStore.getItemAsync(COACH_MARKS_STORAGE_KEY);
        if (!seen) setShowCoachMarks(true);
      } catch {
        // best-effort — if we can't read the flag, don't force the tour on the user
      }
    })();
  }, []);

  // Re-derive the Req 4.4 badge from the current refs. Stable identity (no
  // deps) so the region-change handler and connectivity subscription below
  // never re-subscribe.
  const updateMapDataBadge = useCallback(() => {
    setMapDataUnavailable(
      apiReachableRef.current === false &&
      !regionHasCachedMapData(viewedRegionRef.current, cachedTileBoundsRef.current),
    );
  }, []);

  // Device connectivity for the Req 4.4 badge. connectivityService (NetInfo +
  // /health probe), NOT the socket-derived isConnected/isOnline flags — those
  // only exist while a group socket is up, and map tiles are needed (and go
  // missing) regardless of convoy state.
  useEffect(() => {
    const unsubscribe = connectivityService.subscribe((online) => {
      apiReachableRef.current = online;
      updateMapDataBadge();
    });
    return unsubscribe;
  }, [updateMapDataBadge]);

  // Cached-tile corridor for the Req 4.4 badge: the active route plus the same
  // 10-mile buffer Req 4.1's prefetch covers. No active route → nothing cached.
  useEffect(() => {
    cachedTileBoundsRef.current = routeCoords.length > 1
      ? computeBoundsWithBuffer(
          routeCoords.map((c) => [c.longitude, c.latitude] as [number, number]),
          CACHED_TILE_BUFFER_MILES,
        )
      : null;
    updateMapDataBadge();
  }, [routeCoords, updateMapDataBadge]);

  const handleRegionChangeComplete = useCallback((region: Region) => {
    viewedRegionRef.current = region;
    updateMapDataBadge();
  }, [updateMapDataBadge]);

  // Incoming SOS alerts arrive over the socket (see `sos:alert` handler below) and are
  // completely independent of any locally-driven modal/sheet state. SosAlertModal is a
  // safety-critical, full-screen <Modal> — if it becomes visible while another <Modal>
  // (hazard report, hazard picker, SOS picker/confirm, route planner) is already open,
  // React Native ends up presenting two native modals at once, which stack unreliably
  // (double-dimmed overlays, unpredictable back-button/dismiss behavior on Android, and
  // "already presenting" issues on iOS). Force-close every other locally-controlled
  // sheet so the emergency alert always has the screen to itself.
  useEffect(() => {
    if (sosAlerts.length === 0) return;
    setFabOpen(false);
    setShowHazardModal(false);
    setShowHazardPicker(false);
    setShowRouteModal(false);
    setShowSosPicker(false);
    setShowSosConfirm(false);
    // These two are also locally-controlled <Modal>s (tutorial spotlight, scenic
    // route sheet) — same stacking hazard as the other modals above.
    setShowScenicSelector(false);
    setShowCoachMarks(false);
  }, [sosAlerts.length]);

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

  // Sync CarPlay + AndroidAuto with current convoy state. Every field of the
  // synced state derives from the member COUNT (and the scalars below), never
  // from individual coordinates — so depend on memberCount / user?.pttCallsign
  // rather than the memberLocations and user objects, which change identity on
  // every member GPS tick / auth write and made this effect rebuild + diff the
  // state object each time for a guaranteed no-op sync.
  const myPttCallsign = user?.pttCallsign ?? '';
  useEffect(() => {
    const state = {
      groupId: groupId ?? null,
      memberCount,
      routeActive: routeCoords.length > 0,
      pttChannelId: pttChannelId ?? null,
      myCallsign: myPttCallsign,
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
      convoyTotalCars: memberCount + 1,
    };
    if (Platform.OS === 'ios') carPlayService.syncStateIfChanged(state);
    else if (Platform.OS === 'android') androidAutoService.syncStateIfChanged(state);
  }, [groupId, memberCount, routeCoords.length, pttChannelId, myPttCallsign, groupName, transmittingCallsign]);

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
          const parts = m.vehicle
            ? [m.vehicle.color, m.vehicle.year, m.vehicle.make, m.vehicle.model].filter(Boolean)
            : [];
          // Req 29.6: show "No vehicle set" rather than silently omitting vehicle info
          // when a Member has no vehicle in their Garage.
          vehicles[m.userId] = parts.length ? parts.join(' ') : 'No vehicle set';
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
    fuelSuggestionShownRef.current = false;
  }, [groupId]);

  // Req 21.1: poll the group's fuel-suggestion status and auto-surface the
  // banner to the Admin once the group has covered 150 miles or run for 2
  // hours, whichever comes first. Backend accumulates true group distance
  // (all members' movement) in `group:<id>:distance_m` — see
  // apps/api/src/socket/socket.handler.ts and apps/api/src/fuel/fuel.routes.ts.
  useEffect(() => {
    if (!groupId || !isAdmin) return;
    let cancelled = false;
    const poll = async () => {
      if (fuelSuggestionShownRef.current) return;
      try {
        const res = await apiClient.get<{ suggest: boolean }>(`/api/v1/groups/${groupId}/fuel/status`);
        if (!cancelled && res.data.suggest && !fuelSuggestionShownRef.current) {
          fuelSuggestionShownRef.current = true;
          setShowFuelBanner(true);
        }
      } catch { /* best-effort — retry on next interval */ }
    };
    void poll();
    const interval = setInterval(poll, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [groupId, isAdmin]);

  // Track own location via LocationService (supports background tracking when expo-task-manager is added)
  useEffect(() => {
    LocationService.setCallback(({ lat, lng, heading, speedKph, ts }) => {
      const pos = { lat, lng };
      myLocationRef.current = pos;
      setMyLocation(pos);
      setMySpeedKph(speedKph);
      // Motion state (Req 33/34) is fed by LocationService._deliverFix — the
      // shared pipeline updates sharedMotionState (→ useMotionStore) with this
      // exact fix before invoking this callback, so no per-screen feed here.
      driveServiceRef.current.addPoint(lat, lng, speedKph);
      wsServiceRef.current?.emitLocation({ lat, lng, heading, speed_kph: speedKph, ts });

      // First GPS fix after mount — backfill hazards/rally now that we have a
      // location to query hazards by proximity (rally backfill doesn't need it,
      // but both are fetched together; see fetchActiveHazardsAndRally).
      if (!initialBackfillDoneRef.current) {
        initialBackfillDoneRef.current = true;
        void fetchActiveHazardsAndRallyRef.current();
      }

      // Req 23.1, 23.2: refresh the HUD to the speed limit of whichever route
      // segment is nearest the driver's current position, so it tracks live
      // progress along the route instead of showing one static value forever.
      const { coords, segmentsKph } = activeRouteSegmentsRef.current;
      if (coords.length > 0 && segmentsKph.length > 0) {
        const segIdx = Math.min(nearestSegmentIndex(lat, lng, coords), segmentsKph.length - 1);
        setPostedSpeedLimitKph(segmentsKph[segIdx] ?? null);
      }
    });
    LocationService.startTracking();
    return () => { LocationService.stopTracking(); };
  }, []);

  // DrivingModeService lifecycle — auto-activates/deactivates Driving Mode on
  // CarPlay (iOS) / Android Auto (Android) connect, with the BT side stubbed
  // out until real native vehicle-BT detection exists (Req 28.1, 28.6).
  useEffect(() => {
    const carPlayProvider = Platform.OS === 'ios' ? carPlayService : androidAutoService;
    const service = new DrivingModeService(noopBluetoothProvider, carPlayProvider);
    drivingModeServiceRef.current = service;
    service.start();
    const unsubscribe = service.subscribe((active) => setDrivingModeActive(active));

    return () => {
      unsubscribe();
      service.stop();
      drivingModeServiceRef.current = null;
    };
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
    // maxSeconds comes from the active group's Admin-configured limit (Req 10.5, 10.6, 16.3),
    // not the user's personal settings — the hold-timer cutoff must match what the Admin set
    // for everyone in this convoy.
    void service.joinChannel({ groupId, channelId: pttChannelId, maxSeconds: groupPttMaxSeconds });

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

  // Apply a live Admin change to the group's PTT max duration without rejoining (Req 10.6)
  useEffect(() => {
    pttServiceRef.current?.setMaxSeconds(groupPttMaxSeconds);
  }, [groupPttMaxSeconds]);

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

  // Backfills active hazards + the group's active rally point — both were previously
  // ONLY ever delivered via live socket push (`hazard:new`/`hazard:nearby`, `rally:set`),
  // so a Member who joins late, or whose app reconnects after being backgrounded/killed,
  // never saw already-active state. Called on mount (once a GPS fix + groupId are
  // available) and whenever the socket reconnects. Best-effort: failures are silent,
  // since the live socket push remains the primary delivery path.
  const fetchActiveHazardsAndRally = useCallback(async () => {
    const loc = myLocationRef.current;
    if (loc) {
      try {
        const res = await apiClient.get<{
          hazards: Array<{
            id: string; type: string; lat: number; lng: number;
            confirmationCount: number; dismissalCount: number; createdAt: string;
          }>;
        }>('/api/v1/hazards', { params: { lat: loc.lat, lng: loc.lng, radius: 20_000 } });
        setHazardPins((prev) => {
          const m = new Map(prev);
          for (const h of res.data.hazards) {
            m.set(h.id, {
              id: h.id,
              type: h.type,
              lat: h.lat,
              lng: h.lng,
              thumbsUp: h.confirmationCount,
              thumbsDown: h.dismissalCount,
              reportedAt: new Date(h.createdAt).getTime(),
            });
          }
          return m;
        });
      } catch { /* best-effort — live socket push remains primary delivery */ }
    }

    if (groupId) {
      try {
        const rp = await rallyService.getActiveRally(groupId);
        if (rp) setRallyPoints((prev) => new Map(prev).set(rp.id, rp));
      } catch { /* best-effort */ }
    }
  }, [groupId]);

  // Ref mirror of fetchActiveHazardsAndRally so the mount-only LocationService
  // callback (deps: []) below always calls the current closure (current groupId)
  // rather than one captured on the first render — same pattern as mySosIdRef.
  const fetchActiveHazardsAndRallyRef = useRef(fetchActiveHazardsAndRally);
  useEffect(() => { fetchActiveHazardsAndRallyRef.current = fetchActiveHazardsAndRally; }, [fetchActiveHazardsAndRally]);

  // Rally backfill doesn't need a GPS fix, so fetch it as soon as groupId is known —
  // a late-joining Member shouldn't have to wait for their first location update to
  // see the group's active rally point. (Hazard backfill happens separately, gated on
  // the first GPS fix in the LocationService callback above, since GET /hazards is
  // proximity-scoped by lat/lng.)
  useEffect(() => {
    if (!groupId) return;
    void fetchActiveHazardsAndRally();
  }, [groupId, fetchActiveHazardsAndRally]);

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
            setRouteCongestionTiers(tiersForAlternative(alts[next]));
            setPostedSpeedLimitKph(alts[next]?.speedLimitKph ?? null);
            activeRouteSegmentsRef.current = { coords, segmentsKph: alts[next]?.speedLimitSegmentsKph ?? [] };
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

    // Admin mute/unmute (Req 10.11) — must actually stop the local mic, since PTT
    // audio flows through Agora only and never touches this backend.
    socket.on('ptt:muted', () => {
      pttServiceRef.current?.setAdminMuted(true);
      setPttAdminMuted(true);
    });
    socket.on('ptt:unmuted', () => {
      pttServiceRef.current?.setAdminMuted(false);
      setPttAdminMuted(false);
    });

    socket.on('connect', () => {
      setIsConnected(true);
      setIsOnline(true);
      clearStalePositions();
      void flushOfflineHazards();
      // Backfill hazards/rally on every (re)connect — covers a Member who was
      // disconnected while a rally point/hazard was broadcast and therefore
      // missed the live `rally:set`/`hazard:new`/`hazard:nearby` push.
      void fetchActiveHazardsAndRallyRef.current();
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
    socket.on('hazard:vote_updated', ({ hazardId, thumbsUp, thumbsDown }: { hazardId: string; thumbsUp: number; thumbsDown: number }) => {
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

    socket.on('route:pushed', (data: { route?: { geometry?: { coordinates?: [number, number][] }; speedLimitKph?: number | null; speedLimitSegmentsKph?: (number | null)[]; congestionSegments?: CongestionLevel[] } }) => {
      // Unlike REST responses, socket payloads aren't runtime-validated on the
      // client, so this guards against a malformed/partial broadcast (e.g. a
      // future "clear route" push reusing this event) instead of assuming the
      // TS annotation reflects what actually arrives over the wire.
      const rawCoords = data.route?.geometry?.coordinates ?? [];
      const coords = rawCoords.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
      setRouteCoords(coords);
      // Pushed routes carry congestion through the broadcast (Req 6.2) —
      // congestionTierSegments pads/truncates, so a short or missing array
      // still yields tiers aligned to the geometry (unknown → no tint).
      setRouteCongestionTiers(congestionTierSegments({
        geometry: { type: 'LineString', coordinates: rawCoords },
        congestionSegments: data.route?.congestionSegments,
      }));
      setPostedSpeedLimitKph(data.route?.speedLimitKph ?? null);
      activeRouteSegmentsRef.current = { coords, segmentsKph: data.route?.speedLimitSegmentsKph ?? [] };
      setShowRouteModal(false);
      Alert.alert('Route Updated', 'The group leader pushed a new route to the convoy.');
    });
    socket.on('navigation:arrived', () => {
      Alert.alert('Arrived!', 'You have reached the convoy destination.');
      setPostedSpeedLimitKph(null);
      activeRouteSegmentsRef.current = { coords: [], segmentsKph: [] };
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

    socket.on('group:ended', (payload?: { durationS?: number; distanceM?: number; memberCount?: number }) => {
      // Exactly-once navigation: for the Admin, ConvoyScreen's end-convoy flow
      // also targets /convoy-end when its POST /end response lands, and the
      // server emits this broadcast (to the whole room, Admin included) while
      // that POST is still in flight. Whichever path claims first navigates;
      // the loser skips its push entirely (Req 7.9).
      const claimed = driveServiceRef.current.claimEndNavigation(groupId);
      // Snapshot locally-computed stats (top speed, route trace) before finishSession()
      // resets the point buffer — Req 19.1/19.4 require the summary to include these,
      // and reading them synchronously avoids waiting on the drive POST round-trip.
      const localStats = claimed ? driveServiceRef.current.peekStats() : null;

      void driveServiceRef.current.finishSession({
        groupId,
        memberCount: memberCountRef.current,
        offlineCache: offlineDB,
        api: { postDrive: (body) => apiClient.post('/api/v1/drives', body).then((r) => r.data) },
        isOnline: () => socket.connected,
      });
      if (claimed) {
        router.push({
          pathname: '/convoy-end' as never,
          params: buildConvoyEndParams({
            groupName,
            memberCount: payload?.memberCount ?? memberCountRef.current,
            durationS: payload?.durationS,
            distanceM: payload?.distanceM,
            localStats,
          }),
        });
      }
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

  // Open person picker — inside a convoy it lists members; outside one it still
  // offers "Yourself" so a standalone SOS can reach friends (Req 25.1, 25.7).
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
    if (!pendingSosCoord) return;
    try {
      // With an active group this broadcasts to the convoy (Req 25.3);
      // without one it goes to friends with location sharing (Req 25.7) —
      // previously the no-group case returned early and silently did nothing.
      const pin = await broadcastSosPin(rallyService, groupId, pendingSosCoord);
      setMySosId(pin.id);
      if (!groupId) {
        // The grouped path gets its own pin + "You" alert echoed back through
        // the group socket's `sos:alert`; there is no socket without a group,
        // so surface the pin and a sent-confirmation locally instead.
        setSosPins((p) => new Map(p).set(pin.id, pin));
        showQuickAlert('🆘 SOS sent to friends sharing location with you');
      }
      // Distinct, strong pattern (same one SosAlertModal uses on the *receiving*
      // side) so the sender gets unmistakable confirmation the emergency
      // broadcast actually went out — previously this safety-critical action
      // gave zero haptic feedback on success.
      HapticService.trigger('error');
    } catch {
      HapticService.trigger('warning');
      // A bare "Could not send SOS." leaves the user with no next step during
      // an actual emergency — point them at the one channel that doesn't
      // depend on this app's connectivity.
      Alert.alert(
        'SOS Not Sent',
        `Your emergency alert didn't reach ${groupId ? 'the convoy' : 'your friends'}. If this is a real emergency, call 911 directly.`,
      );
    }
    setPendingSosCoord(null);
    setPendingSosName('');
  }, [groupId, pendingSosCoord, showQuickAlert]);

  const cancelMySos = useCallback(async () => {
    if (!mySosId) return;
    const cancelledId = mySosId;
    try {
      await cancelSosPin(rallyService, groupId, cancelledId);
      if (!groupId) {
        // The grouped path clears mySosId/sosPins when the server echoes
        // `sos:cancelled` back over the group socket; a standalone SOS has no
        // socket, so mirror that cleanup locally.
        setSosPins((p) => { const n = new Map(p); n.delete(cancelledId); return n; });
        setMySosId(null);
      }
    } catch { Alert.alert('Error', 'Could not cancel SOS.'); }
  }, [groupId, mySosId]);

  // Shared "calculate + render a route to this point" logic used by every entry point
  // that produces a destination coordinate (top search bar, Plan Route modal, dropped
  // pin "Get Directions", recent destinations).
  const calculateRouteToDestination = useCallback(async (
    dest: { lat: number; lng: number },
    opts?: { offerRouteChoice?: boolean },
  ) => {
    // Read position from myLocationRef (updated on every GPS tick alongside the
    // myLocation state) instead of the state itself — an event-time read is
    // always current, and dropping the state dep keeps this callback's identity
    // stable across GPS ticks so memoized children (DestinationSearch et al.)
    // that receive it (directly or via handleSearchSelect) can bail out.
    const origin = myLocationRef.current;
    if (!origin) {
      Alert.alert('Location unavailable', 'Waiting for a GPS fix before we can calculate a route.');
      return;
    }
    setIsCalcRoute(true);
    try {
      const routeBody = { origin: { lat: origin.lat, lng: origin.lng }, destination: dest, scenic: scenicRouting };
      let alts: RouteAlternative[] | undefined;

      if (scenicRouting) {
        // Req 22.3: present the scenic variant as the default selection, with
        // standard routes still available as alternates — fetch both in parallel.
        const [scenicRes, standardRes] = await Promise.all([
          apiClient.post<{ routes: RouteAlternative[] }>('/api/v1/routes/calculate', routeBody),
          apiClient.post<{ routes: RouteAlternative[] }>('/api/v1/routes/calculate', { ...routeBody, scenic: false }),
        ]);
        const scenicAlts = scenicRes.data.routes ?? [];
        const standardAlts = standardRes.data.routes ?? [];
        if (!scenicAlts.length) {
          // Req 22.4: notify and fall back to standard routing when scenic is unavailable.
          Alert.alert('Scenic unavailable', 'Scenic routing is not available for this route. Showing standard routes.');
          alts = standardAlts;
        } else {
          alts = [...scenicAlts, ...standardAlts];
        }
      } else {
        const routeRes = await apiClient.post<{ routes: RouteAlternative[] }>('/api/v1/routes/calculate', routeBody);
        alts = routeRes.data.routes;
      }

      if (!alts?.length) {
        Alert.alert('No route found', 'Could not find a route to that destination.');
        return;
      }
      setRouteAlternatives(alts);
      setSelectedRouteIdx(0);
      const coords = alts[0].geometry.coordinates.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
      setRouteCoords(coords);
      setRouteCongestionTiers(tiersForAlternative(alts[0]));
      setPostedSpeedLimitKph(alts[0]?.speedLimitKph ?? null);
      activeRouteSegmentsRef.current = { coords, segmentsKph: alts[0]?.speedLimitSegmentsKph ?? [] };
      activeDestRef.current = dest;
      showQuickAlert(`${alts[0].distanceText} · ${alts[0].durationText}`);
      // Route is already drawn using the default (first) alternative above — this
      // just offers a chance to switch to another alternative (e.g. fastest vs.
      // scenic) before continuing. Only offered for entry points that don't already
      // have their own route-choice UI (the Plan Route modal has its own inline list).
      if (opts?.offerRouteChoice && alts.length > 1) {
        setShowScenicSelector(true);
      }
    } catch {
      Alert.alert('Error', 'Could not calculate route.');
    } finally {
      setIsCalcRoute(false);
    }
  }, [scenicRouting, showQuickAlert]);

  const handleSearchSelect = useCallback((result: SearchResult) => {
    const destCoord = { latitude: result.lat, longitude: result.lng };
    // myLocationRef, not myLocation state: keeps this callback stable across GPS
    // ticks — it's DestinationSearch's onSelect prop, and that component is
    // memoized. The event-time ref read is always current.
    const loc = myLocationRef.current;
    // Frame both the current location and the destination so the new route is visible,
    // falling back to a simple pan when we don't have a GPS fix yet.
    if (loc && mapRef.current) {
      mapRef.current.fitToCoordinates(
        [{ latitude: loc.lat, longitude: loc.lng }, destCoord],
        { edgePadding: { top: 120, right: 60, bottom: 300, left: 60 }, animated: true },
      );
    } else {
      mapRef.current?.animateToRegion({ ...destCoord, latitudeDelta: 0.02, longitudeDelta: 0.02 }, 600);
    }
    // Selecting a search result must actually start turn-by-turn routing, not just
    // recenter the camera — previously this handler only panned the map, so typing
    // an address and picking a result produced no route/directions at all.
    // offerRouteChoice: true — this is the one entry point with no existing route-
    // choice UI of its own, so it's where ScenicRouteSelector gets offered.
    void calculateRouteToDestination({ lat: result.lat, lng: result.lng }, { offerRouteChoice: true });
  }, [calculateRouteToDestination]);

  const handlePttStart = useCallback(() => {
    HapticService.pttStart();
    pttPressActiveRef.current = true;
    // Request mic permission lazily on first PTT attempt (Req 36.6)
    if (!micPermGrantedRef.current) {
      void requestMicPermissionForPTT().then((granted) => {
        micPermGrantedRef.current = granted;
        // The user may have already released the button while the permission
        // prompt was pending — don't start transmitting into a press that's over.
        if (!granted || !pttPressActiveRef.current) return;
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
    pttPressActiveRef.current = false;
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
    // Ref read (not myLocation state) — same stable-identity rationale as
    // calculateRouteToDestination above, which re-checks the fix itself.
    if (!myLocationRef.current || !routeDestInput.trim()) return;
    setIsCalcRoute(true);
    try {
      const searchRes = await apiClient.get<Array<{ lat: number; lng: number; name: string }>>(
        `/api/v1/places/search?q=${encodeURIComponent(routeDestInput.trim())}`,
      );
      const dest = Array.isArray(searchRes.data) ? searchRes.data[0] : undefined;
      if (!dest) { Alert.alert('No results', 'No location found for that search.'); return; }
      await calculateRouteToDestination({ lat: dest.lat, lng: dest.lng });
    } catch {
      Alert.alert('Error', 'Could not calculate route.');
    } finally {
      setIsCalcRoute(false);
    }
  }, [routeDestInput, calculateRouteToDestination]);

  const handleSelectRouteAlt = useCallback((idx: number) => {
    setSelectedRouteIdx(idx);
    const alt = routeAlternatives[idx];
    const coords = alt?.geometry.coordinates.map(([lng, lat]) => ({ latitude: lat, longitude: lng })) ?? [];
    setRouteCoords(coords);
    setRouteCongestionTiers(tiersForAlternative(alt));
    setPostedSpeedLimitKph(alt?.speedLimitKph ?? null);
    activeRouteSegmentsRef.current = { coords, segmentsKph: alt?.speedLimitSegmentsKph ?? [] };
  }, [routeAlternatives]);

  // Adapts the backend's RouteAlternative[] shape to ScenicRouteSelector's RouteOption[]
  // prop. Note: the backend doesn't currently return a per-route scenicScore, so that
  // field is left undefined here — ScenicRouteSelector already treats it as optional
  // (its "Most Scenic" badge simply won't render without one; "Fastest" still can).
  const scenicSelectorRoutes = useMemo<RouteOption[]>(() => routeAlternatives.map((alt, idx) => ({
    index: idx,
    distanceText: alt.distanceText,
    durationText: alt.durationText,
    speedLimitKph: alt.speedLimitKph,
  })), [routeAlternatives]);

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
          speedLimitKph: alt.speedLimitKph ?? null,
          speedLimitSegmentsKph: alt.speedLimitSegmentsKph ?? [],
          // Members' maps color the pushed route line from this (Req 6.2) —
          // the server broadcasts it through route:pushed unchanged.
          congestionSegments: alt.congestionSegments ?? [],
        },
      });
      setShowRouteModal(false);
    } catch {
      Alert.alert('Error', 'Could not push route to group.');
    }
  }, [groupId, routeAlternatives, selectedRouteIdx]);

  const handleHazardSelect = useCallback(async (type: HazardType) => {
    // myLocationRef read at press time (always current) — a myLocation state dep
    // would change this callback's identity every GPS tick and defeat the
    // memoized HazardPicker that receives it as onSelect.
    const loc = myLocationRef.current;
    if (!loc) {
      Alert.alert('Location required', 'Enable location permissions to report a hazard.');
      return;
    }
    // HazardService queues the report in the offline cache on failure, so it
    // really is synced later (Req 11.9, 11.10) rather than just dropped.
    const result = await hazardService.report(type, loc.lat, loc.lng);
    if (!result) {
      Alert.alert('Hazard Queued', 'No connection — this report will send once you reconnect.');
    }
  }, []);

  const handleFuelStationSelect = useCallback(async (station: { id: string; name: string; distanceM: number; lat: number; lng: number; address: string }) => {
    if (!groupId) return;
    // Req 21.3: the accepted station becomes a ROUTE waypoint (recalculated
    // through it and pushed to the group), never a rally point. Our own map
    // applies the result via the route:pushed socket handler like everyone
    // else's, so no local route state is written here.
    const origin = myLocationRef.current;
    if (!origin) return;
    try {
      const applied = await applyFuelStopWaypoint({
        groupId,
        origin,
        station: { lat: station.lat, lng: station.lng },
        destination: activeDestRef.current,
      });
      if (!applied) {
        Alert.alert('No Route', 'No route found through that station.');
        return;
      }
      setShowFuelBanner(false);
    } catch {
      Alert.alert('Error', 'Could not add the fuel stop to the route.');
    }
  }, [groupId]);

  // Gap severity per member, computed once per gapAlerts change — the marker
  // loop and member rows previously each ran a gapAlerts.find() per member per
  // render (O(members × alerts) on every GPS tick).
  const gapStatusById = useMemo(() => {
    const byId: Record<string, 'warning' | 'alert'> = {};
    for (const a of gapAlerts) {
      byId[a.memberId] = a.distanceM > gapThresholdM * 1.5 ? 'alert' : 'warning';
    }
    return byId;
  }, [gapAlerts, gapThresholdM]);

  // When disconnected, merge stale (cached) positions for members not in live data.
  // (Hoisted above renderMemberRow: the distance origin below needs the merged list.)
  const members = useMemo(() => {
    const liveMemberIds = new Set(Object.keys(memberLocations));
    const staleFallback = Object.values(stalePositions).filter((p) => !liveMemberIds.has(p.userId));
    return [...Object.values(memberLocations), ...staleFallback];
  }, [memberLocations, stalePositions]);

  // Req 8.4: member-list distances are measured from the ADMIN's position (or
  // the caller's own fix when the admin's is unknown — see resolveDistanceOrigin).
  const distanceOrigin = useMemo(
    () => resolveDistanceOrigin(groupAdminId, user?.id, myLocation, members),
    [groupAdminId, user?.id, myLocation, members],
  );

  const renderMemberRow = useCallback(({ item: m }: { item: MemberLocation }) => {
    const isStale = Date.now() - m.receivedAt > 30_000;
    const memberName = m.displayName ?? `Member ${m.userId.slice(0, 6)}`;
    const callsign = memberCallsignsRef.current[m.userId];
    const gapStatus = gapStatusById[m.userId];
    const dotColor = isStale ? colors.textSubtle : gapStatus === 'alert' ? colors.accent : gapStatus === 'warning' ? colors.warning : colors.success;
    // Distance from the Admin's position, not from the viewer (Req 8.4) —
    // distanceOrigin already falls back to the viewer's own fix when unknown.
    const distM = distanceOrigin ? haversineDistanceM(distanceOrigin.lat, distanceOrigin.lng, m.lat, m.lng) : null;
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
              <Ionicons name="battery-dead" size={13} color={colors.accent} accessibilityLabel="Low battery" />
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
            <MaterialIcons name="sos" size={18} color={colors.accent} />
          </TouchableOpacity>
        )}
      </View>
    );
  // distanceOrigin stays a dep on purpose: rows display live distances, so they
  // must re-render per GPS tick (caller-origin) / member update (admin-origin)
  // while the member list is open.
  }, [groupId, handlePickSosTarget, gapStatusById, distanceOrigin, styles, colors]);

  const staleMs = 30_000;

  // Sort members closest-first from the same origin the rows display (Req 8.4:
  // the Admin's position when known) so the list order matches the distances shown.
  const sortedMembers = useMemo(() => {
    if (!distanceOrigin) return members;
    return [...members].sort((a, b) => {
      const da = haversineDistanceM(distanceOrigin.lat, distanceOrigin.lng, a.lat, a.lng);
      const db = haversineDistanceM(distanceOrigin.lat, distanceOrigin.lng, b.lat, b.lng);
      return da - db;
    });
  }, [members, distanceOrigin]);

  const rallies = useMemo(() => Array.from(rallyPoints.values()), [rallyPoints]);
  const sosPinList = useMemo(() => Array.from(sosPins.values()), [sosPins]);
  // Materialized once per hazardPins change; the JSX previously ran
  // Array.from() on every render. The expiry .filter() stays inline in the JSX
  // on purpose — it depends on Date.now(), so memoizing it would keep expired
  // pins visible until the next hazardPins state change.
  const hazardPinList = useMemo(() => Array.from(hazardPins.values()), [hazardPins]);

  // Derived once per render instead of four separate deriveMotionState() calls
  // in the JSX. As a boolean it is also a memo-friendly prop: DestinationSearch,
  // PTTLogPanel and HazardPicker only re-render when the motion STATE flips,
  // not on every speed change.
  const isInMotion = deriveMotionState(mySpeedKph) === 'in_motion';

  // FlatList data — memoized so the in-motion `.slice(0, 4)` doesn't hand the
  // list a brand-new array identity on every render.
  const memberListData = useMemo(
    () => (isInMotion ? sortedMembers.slice(0, 4) : sortedMembers),
    [isInMotion, sortedMembers],
  );

  // Search-bias coordinates for DestinationSearch, quantized to ~110 m
  // (3 decimal places). The raw fix changes every GPS tick, which forced the
  // memoized search bar to re-render per tick; a 110 m step is far below the
  // city-scale viewbox bias the backend applies, so results are unaffected.
  const searchBiasLat = myLocation == null ? null : Math.round(myLocation.lat * 1000) / 1000;
  const searchBiasLng = myLocation == null ? null : Math.round(myLocation.lng * 1000) / 1000;

  // Weather coordinates, quantized to ~2 km (0.02°). useWeather's effect keys
  // on [latitude, longitude], so passing the raw per-tick fix tore the effect
  // down and issued a fresh Open-Meteo fetch on EVERY GPS tick (its documented
  // 10-minute refresh interval never survived long enough to fire). Weather is
  // ~10 km-scale data; a 2 km step is well inside its resolution.
  const weatherLat = myLocation == null ? null : Math.round(myLocation.lat * 50) / 50;
  const weatherLng = myLocation == null ? null : Math.round(myLocation.lng * 50) / 50;

  // Stable identities for memoized children's close/dismiss props — inline
  // arrows would be recreated on every GPS-tick render and defeat their memo.
  const closeHazardPicker = useCallback(() => setShowHazardPicker(false), []);
  const closeHazardModal = useCallback(() => setShowHazardModal(false), []);
  const closeScenicSelector = useCallback(() => setShowScenicSelector(false), []);
  const completeCoachMarks = useCallback(() => setShowCoachMarks(false), []);
  const dismissFuelBanner = useCallback(() => setShowFuelBanner(false), []);
  const dismissGapAlert = useCallback(() => setGapAlerts((p) => p.slice(1)), []);

  // SosAlertModal handlers — stable except when the alert queue itself changes.
  const handleSosNavigate = useCallback(() => {
    const first = sosAlerts[0];
    if (first) {
      mapRef.current?.animateToRegion({
        latitude: first.pin.lat,
        longitude: first.pin.lng,
        latitudeDelta: 0.01,
        longitudeDelta: 0.01,
      }, 800);
    }
    setSosAlerts((p) => p.slice(1));
  }, [sosAlerts]);
  const handleSosDismiss = useCallback(() => setSosAlerts((p) => p.slice(1)), []);
  const handleSosAcknowledge = useCallback(() => {
    const first = sosAlerts[0];
    if (socketRef.current && first) {
      socketRef.current.emit('sos:acknowledge', { sosId: first.pin.id, memberName: first.memberName });
    }
    setSosAlerts((p) => p.slice(1));
  }, [sosAlerts]);

  // Safe-area-aware top offset for floating UI elements.
  // ConvoyBanner (rendered below, always visible on this screen) is a self-positioned,
  // 90%-width pill anchored at `insets.top + 8` with zIndex 100 — the highest in this
  // screen. Without this extra offset, the search bar / connection badge / re-center
  // button (all previously anchored at insets.top + 8 too) rendered directly underneath
  // it every time, since they share the same vertical band and ConvoyBanner's pill spans
  // almost the full screen width. Push this row down by the banner's height (44) plus
  // margins so the two rows stack instead of overlapping.
  const topBase = insets.top + 8 + 52;

  // Weather data for the HUD pill (non-critical — silently omitted when
  // unavailable). Quantized coords — see weatherLat/weatherLng above.
  const weather = useWeather({ latitude: weatherLat, longitude: weatherLng });

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
        onRegionChangeComplete={handleRegionChangeComplete}
      >
        {members.map((m: MemberLocation) => {
          const gapStatus = gapStatusById[m.userId] ?? ('ok' as const);
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
            pinColor={colors.warning}
            onCalloutPress={() => {
              Alert.alert(
                'Dropped Pin',
                droppedPin.address ?? `${droppedPin.lat.toFixed(5)}, ${droppedPin.lng.toFixed(5)}`,
                [
                  { text: 'Remove Pin', style: 'destructive', onPress: () => setDroppedPin(null) },
                  {
                    text: 'Get Directions',
                    onPress: () => {
                      void calculateRouteToDestination({ lat: droppedPin.lat, lng: droppedPin.lng });
                    },
                  },
                  { text: 'Cancel', style: 'cancel' },
                ],
              );
            }}
          />
        )}
        {rallies.map((r) => (
          <Marker key={r.id} coordinate={{ latitude: r.lat, longitude: r.lng }} title="Rally Point" description={r.address ?? undefined} pinColor={colors.success} />
        ))}
        {sosPinList.map((s) => (
          <Marker key={s.id} coordinate={{ latitude: s.lat, longitude: s.lng }} title="SOS" pinColor={colors.accent} />
        ))}
        {hazardPinList
          .filter((h) => !h.reportedAt || Date.now() - h.reportedAt < HAZARD_EXPIRY_MS)
          .map((h) => (
          <Marker
            key={h.id}
            coordinate={{ latitude: h.lat, longitude: h.lng }}
            pinColor={colors.warning}
            title={hazardLabel(h.type)}
          >
            <Callout tooltip onPress={() => {}}>
              <View style={overlayStyles.hazardCallout}>
                <Text style={overlayStyles.hazardCalloutTitle}>
                  {HAZARD_EMOJI[h.type] ?? '⚠️'} {hazardLabel(h.type)}
                </Text>
                {h.reportedBy ? (
                  <Text style={overlayStyles.hazardCalloutSub}>Reported by {h.reportedBy}</Text>
                ) : null}
                {myLocation ? (
                  <Text style={overlayStyles.hazardCalloutSub}>
                    {formatDistance(haversineDistanceM(myLocation.lat, myLocation.lng, h.lat, h.lng))} away
                  </Text>
                ) : null}
                {h.reportedAt ? (
                  <Text style={overlayStyles.hazardCalloutSub}>{formatTimeAgo(h.reportedAt)}</Text>
                ) : null}
                <View style={overlayStyles.hazardVoteRow}>
                  <TouchableOpacity
                    style={overlayStyles.hazardVoteBtn}
                    onPress={() => voteHazard(h.id, 'up')}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel={`Confirm hazard still there, ${h.thumbsUp} votes`}
                  >
                    <Ionicons name="thumbs-up" size={13} color={colors.text} />
                    <Text style={overlayStyles.hazardVoteText}> {h.thumbsUp}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={overlayStyles.hazardVoteBtn}
                    onPress={() => voteHazard(h.id, 'down')}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityRole="button"
                    accessibilityLabel={`Report hazard not there, ${h.thumbsDown} votes`}
                  >
                    <Ionicons name="thumbs-down" size={13} color={colors.text} />
                    <Text style={overlayStyles.hazardVoteText}> {h.thumbsDown}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </Callout>
          </Marker>
        ))}
        {/* Active route line with four-tier congestion color coding (Req 6.2);
            untinted segments fall back to the classic accent route color. */}
        {routeCoords.length > 0 && (
          <CongestionRoutePolyline
            coordinates={routeCoords}
            tiers={routeCongestionTiers}
            defaultColor={colors.accent}
          />
        )}
      </MapView>

      {/* Offline banner — shown when socket is disconnected.
          styles.offlineBanner previously hardcoded `top: 0`, ignoring the safe-area inset,
          so on notched / Dynamic-Island devices this message rendered partly underneath
          the status bar / sensor housing instead of below it. */}
      {!isConnected && (
        <View style={[styles.offlineBanner, { top: insets.top }]}>
          <Text style={styles.offlineBannerText}>Connection lost — showing last known positions</Text>
        </View>
      )}

      {/* Floating search bar — hidden in driving mode (Req 28) */}
      {!drivingModeActive && (
        <View style={[styles.searchWrapper, { top: topBase }]}>
          <DestinationSearch
            isOnline={isOnline}
            isInMotion={isInMotion}
            onSelect={handleSearchSelect}
            userLat={searchBiasLat}
            userLng={searchBiasLng}
          />
        </View>
      )}

      {/* Connection badge — top-right */}
      <View style={[styles.badge, isConnected ? styles.badgeOnline : styles.badgeOffline, { top: topBase }]}>
        <Text style={[styles.badgeText, isConnected && styles.badgeOnlineText]}>{isConnected ? 'LIVE' : 'OFFLINE'}</Text>
      </View>

      {/* Map data unavailable badge (Req 4.4) — offline and the viewed area is
          outside the cached tile corridor (active route + 10-mile buffer). */}
      {mapDataUnavailable && (
        <View style={[styles.mapDataBadgeWrap, { top: topBase + 88 }]} pointerEvents="none">
          <MapDataUnavailableBadge />
        </View>
      )}

      {/* Map style cycle button — top-right, below LIVE badge */}
      <TouchableOpacity
        style={[styles.mapTypeBtn, { top: topBase + 40 }]}
        onPress={cycleMapType}
        accessibilityRole="button"
        accessibilityLabel={`Map style: ${mapStyle}. Tap to cycle.`}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        {/* This chip's background is a fixed dark translucent pill regardless of app
            theme (it floats directly over the map surface), so the icon stays a
            fixed light color rather than following colors.text. */}
        <MaterialCommunityIcons
          name={mapStyle === 'standard' ? 'map-outline' : mapStyle === 'satellite' ? 'satellite-variant' : 'earth'}
          size={18}
          color="#FFFFFF"
        />
      </TouchableOpacity>

      {/* Re-center — top-left, below safe area */}
      <TouchableOpacity
        style={[styles.recenterBtn, { top: topBase }]}
        onPress={recenter}
        accessibilityRole="button"
        accessibilityLabel="Re-center on my location"
      >
        <Ionicons name="locate" size={22} color={colors.text} />
      </TouchableOpacity>

      {/* Auto-center on all convoy members — appears when disabled */}
      {groupId && !autoCenterAll && (
        <TouchableOpacity
          style={[styles.recenterBtn, { top: topBase + 52 }]}
          onPress={() => setAutoCenterAll(true)}
          accessibilityRole="button"
          accessibilityLabel="Fit map to all convoy members"
        >
          <MaterialCommunityIcons name="crosshairs-gps" size={22} color={colors.text} />
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
        <SpeedLimitHUD
          postedLimitKph={postedSpeedLimitKph}
          currentSpeedKph={mySpeedKph}
          preferredUnit={distanceUnit === 'miles' ? 'mph' : 'kmh'}
        />
      </View>

      {/* Floating action button — hidden in driving mode (Req 28). Deliberately NOT
          gated on groupId: the SOS entry point must stay reachable with no active
          convoy so a standalone SOS can reach friends (Req 25.1, 25.7); group-only
          items inside the menu gate themselves individually. */}
      {!drivingModeActive && user && (
        <View style={[styles.fabContainer, { bottom: insets.bottom + 88 }]}>
          {fabOpen && (
            <>
              <TouchableOpacity
                style={styles.fabItem}
                onPress={() => {
                  setFabOpen(false);
                  if (isInMotion) {
                    Alert.alert('Pull Over First', 'Please stop before planning a route.');
                    return;
                  }
                  setShowRouteModal(true);
                }}
                accessibilityLabel="Plan route"
                accessibilityRole="button"
              >
                <Ionicons name="map" size={22} color={colors.text} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.fabItem, drivingModeActive && styles.fabItemActive]}
                onPress={() => { setFabOpen(false); drivingModeServiceRef.current?.setManualActive(!drivingModeActive); }}
                accessibilityLabel={drivingModeActive ? 'Exit driving mode' : 'Enter driving mode'}
                accessibilityRole="button"
              >
                <Ionicons name="car" size={22} color={drivingModeActive ? '#FFFFFF' : colors.text} />
              </TouchableOpacity>
              {/* Group-only: FuelSuggestionBanner queries the group's fuel status and
                  pushes the chosen station as a route waypoint (Req 21.3). */}
              {groupId ? (
                <TouchableOpacity
                  style={styles.fabItem}
                  onPress={() => { setFabOpen(false); setShowFuelBanner((v) => !v); }}
                  accessibilityLabel="Find fuel nearby"
                  accessibilityRole="button"
                >
                  <MaterialCommunityIcons name="gas-station" size={22} color={colors.text} />
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                style={styles.fabItem}
                onPress={() => { setFabOpen(false); setHazardModalCoords(myLocation); setShowHazardModal(true); }}
                accessibilityLabel="Report a road hazard"
                accessibilityRole="button"
              >
                <Ionicons name="warning" size={22} color={colors.text} />
              </TouchableOpacity>
              {mySosId ? (
                <TouchableOpacity
                  style={[styles.fabItem, styles.fabSosCancelItem, { flexDirection: 'row', gap: 4 }]}
                  onPress={() => { setFabOpen(false); void cancelMySos(); }}
                  accessibilityLabel="Cancel SOS"
                  accessibilityRole="button"
                >
                  <Ionicons name="close" size={14} color={colors.text} />
                  <Text style={styles.fabItemText}>SOS</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[styles.fabItem, styles.fabSosItem]}
                  onPress={() => { setFabOpen(false); handleSosPress(); }}
                  accessibilityLabel="Send SOS alert"
                  accessibilityHint={groupId ? 'Alerts your convoy of an emergency' : 'Alerts your friends of an emergency'}
                  accessibilityRole="button"
                >
                  <MaterialIcons name="sos" size={22} color={colors.accent} />
                </TouchableOpacity>
              )}
              {pttChannelId && (
                <Pressable
                  style={[
                    styles.fabItem,
                    styles.fabPttItem,
                    fabPttActive && styles.fabPttItemActive,
                    (!pttVoiceAvailable || pttAdminMuted) && styles.fabPttItemUnavailable,
                  ]}
                  onPressIn={() => { if (pttVoiceAvailable && !pttAdminMuted) { setFabPttActive(true); handlePttStart(); } }}
                  onPressOut={() => { setFabPttActive(false); handlePttEnd(); }}
                  accessibilityLabel={
                    pttAdminMuted
                      ? 'Muted by admin'
                      : !pttVoiceAvailable
                        ? 'Voice unavailable'
                        : fabPttActive
                          ? 'Transmitting voice'
                          : 'Push to Talk'
                  }
                  accessibilityHint="Hold to broadcast voice to convoy"
                  accessibilityRole="button"
                >
                  <Ionicons
                    name={pttAdminMuted ? 'mic-off' : pttVoiceAvailable ? 'mic' : 'ban'}
                    size={20}
                    color={fabPttActive ? '#FFFFFF' : (pttAdminMuted || !pttVoiceAvailable) ? colors.textMuted : colors.text}
                  />
                  {/* Text color mirrors the icon's logic above — fabPttItem's background is
                      colors.card except when active/unavailable, so a fixed white label
                      (as before) went invisible against a light-theme card. */}
                  <Text style={[styles.fabPttLabel, { color: fabPttActive ? '#FFFFFF' : (pttAdminMuted || !pttVoiceAvailable) ? colors.textMuted : colors.text }]}>
                    {pttAdminMuted ? 'MUTED' : !pttVoiceAvailable ? 'NO VOICE' : fabPttActive ? 'LIVE' : 'PTT'}
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
            <Ionicons name={fabOpen ? 'close' : 'flash'} size={26} color={colors.text} />
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

      {/* Quick-action alert pills — above PTT button, only when in a group.
          Hidden while the FAB menu is expanded: styles.quickActionRow spans left:16 to
          right:16 (nearly full screen width), and the expanded FAB item stack
          (styles.fabContainer, anchored at right:16) grows upward from
          insets.bottom + 88 by up to ~430px (6 possible fabItems @ 60px each + fabMain),
          which reaches straight through both quick-action rows' vertical band
          (insets.bottom + 190 to insets.bottom + 264). With both visible at once the FAB
          buttons and the alert pills rendered stacked on top of one another. */}
      {groupId && pttChannelId && !drivingModeActive && !fabOpen && (
        <>
          <View style={[styles.quickActionRow, { bottom: insets.bottom + 228 }]}>
            {QUICK_ACTIONS.map(({ type, label, message, icon }) => (
              <TouchableOpacity
                key={type}
                style={styles.quickActionPill}
                onPress={() => sendQuickAlert(type, message)}
                accessibilityRole="button"
                accessibilityLabel={`Send ${label} alert to convoy`}
              >
                <Ionicons name={icon} size={14} color={colors.text} />
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
              {/* hazardQuickPill overrides the background to a fixed dark amber tint
                  regardless of theme, so this icon/label stay fixed white. */}
              <Ionicons name="warning" size={14} color="#FFFFFF" />
              <Text style={[styles.quickActionPillText, { color: '#FFFFFF' }]}>Report Hazard</Text>
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
              (!pttVoiceAvailable || pttAdminMuted) && styles.pttStandaloneBtnUnavailable,
            ]}
            onPressIn={() => { if (pttVoiceAvailable && !pttAdminMuted) { setFabPttActive(true); handlePttStart(); } }}
            onPressOut={() => { setFabPttActive(false); handlePttEnd(); }}
            accessibilityLabel="Push to talk"
            accessibilityHint="Hold to transmit voice to group"
            accessibilityRole="button"
          >
            <Ionicons
              name={pttAdminMuted ? 'mic-off' : pttVoiceAvailable ? 'mic' : 'ban'}
              size={30}
              color={isPttTransmitting ? '#FFFFFF' : (pttAdminMuted || !pttVoiceAvailable) ? colors.textSubtle : colors.text}
            />
          </Pressable>
          <Text style={[styles.pttStandaloneLabel, isPttTransmitting && styles.pttStandaloneLabelActive]}>
            {pttAdminMuted ? 'MUTED BY ADMIN' : !pttVoiceAvailable ? 'NO VOICE' : isPttTransmitting ? 'TRANSMITTING' : 'HOLD TO TALK'}
          </Text>
        </View>
      )}

      {/* Fuel suggestion banner — pinned safely above the quick-action pill rows.
          Previously used a hardcoded `bottom: 220` (styles.fuelBannerWrapper) that ignored
          insets.bottom entirely, while the quick-action rows below use
          `insets.bottom + 190` / `insets.bottom + 228`. On devices with a non-zero bottom
          inset (home-indicator phones) those values land at ~224 and ~262 — both inside or
          immediately adjacent to the fuel banner's band — so opening the fuel banner while
          in an active convoy with a PTT channel rendered it directly on top of the
          "Report Hazard" / "Stopping / Regrouping / Incident" pills. */}
      {showFuelBanner && myLocation && (
        <View style={[styles.fuelBannerWrapper, { bottom: insets.bottom + 274 }]}>
          {/* Quantized coords (~110 m) + stable onDismiss so this memoized
              banner doesn't re-render on every GPS tick while open; the fuel
              search radius is kilometers, so the rounding is immaterial. */}
          <FuelSuggestionBanner
            groupId={groupId}
            myLat={Math.round(myLocation.lat * 1000) / 1000}
            myLng={Math.round(myLocation.lng * 1000) / 1000}
            isAdmin={isAdmin}
            onSelectStation={handleFuelStationSelect}
            onDismiss={dismissFuelBanner}
          />
        </View>
      )}

      {/* Gap alerts — use GapAlertBanner for the most recent alert */}
      {gapAlerts.length > 0 && (
        <View accessibilityLiveRegion="polite" accessible={false}>
          <GapAlertBanner
            memberName={memberNamesRef.current[gapAlerts[0].memberId] ?? `Member ${gapAlerts[0].memberId.slice(0, 6)}`}
            distanceM={gapAlerts[0].distanceM}
            thresholdM={gapThresholdM}
            onDismiss={dismissGapAlert}
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
              <Ionicons name="close" size={16} color="#888888" />
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Rally alert */}
      {rallyAlert && (
        <TouchableOpacity
          style={styles.rallyBanner}
          onPress={() => {
            // Req 20.4: tapping the Rally_Point alert must calculate an independent
            // route from this Member's current location to the Rally_Point.
            void calculateRouteToDestination({ lat: rallyAlert.lat, lng: rallyAlert.lng });
            setRallyAlert(null);
          }}
          accessibilityRole="button"
          accessibilityLabel={`Rally Point${rallyAlert.address ? `: ${rallyAlert.address}` : ''} — tap for directions`}
        >
          <View style={styles.rallyBannerStrip} />
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10 }}>
            <MaterialCommunityIcons name="flag-variant" size={16} color={colors.success} />
            <Text style={styles.rallyBannerText}>
              Rally Point set{rallyAlert.address ? `: ${rallyAlert.address}` : ''} — Tap for directions
            </Text>
          </View>
        </TouchableOpacity>
      )}

      {/* SOS alerts — modal for the first active alert */}
      <SosAlertModal
        visible={sosAlerts.length > 0}
        memberName={sosAlerts[0]?.memberName ?? ''}
        locationLat={sosAlerts[0]?.pin.lat ?? 0}
        locationLng={sosAlerts[0]?.pin.lng ?? 0}
        onNavigate={handleSosNavigate}
        onDismiss={handleSosDismiss}
        onAcknowledge={handleSosAcknowledge}
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
              <Ionicons name="car" size={16} color={colors.text} />
              <Text style={styles.panelCollapsedText}>
                {members.length} {members.length === 1 ? 'rider' : 'riders'}
              </Text>
              {pttChannelId ? (
                <Pressable
                  style={[styles.miniPttBtn, isPttTransmitting && styles.miniPttBtnActive]}
                  onPressIn={() => { if (pttVoiceAvailable && !pttAdminMuted) handlePttStart(); }}
                  onPressOut={handlePttEnd}
                  accessibilityLabel={pttAdminMuted ? 'Muted by admin' : 'Hold to push to talk'}
                  accessibilityRole="button"
                >
                  <Ionicons
                    name={pttAdminMuted ? 'mic-off' : isPttTransmitting ? 'radio' : 'mic'}
                    size={16}
                    color={isPttTransmitting ? colors.accent : colors.text}
                  />
                </Pressable>
              ) : null}
              <Ionicons name="chevron-up" size={18} color={colors.textMuted} />
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
                  ? <PTTLogPanel socket={socket} groupId={groupId} isInMotion={isInMotion} />
                  : <View style={styles.panelConnecting}><Text style={styles.emptyText}>Connecting…</Text></View>
              ) : (
                <FlatList
                  data={memberListData}
                  keyExtractor={memberKeyExtractor}
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
      <Modal
        transparent
        visible={showSosPicker}
        animationType="slide"
        onRequestClose={() => setShowSosPicker(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, styles.pickerBox]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <MaterialIcons name="sos" size={20} color={colors.accent} />
              <Text style={[styles.modalTitle, { marginBottom: 0 }]}>SOS — Who needs help?</Text>
            </View>
            <Text style={styles.pickerSubtitle}>
              {groupId
                ? 'Their current location will be broadcast to all convoy members.'
                : 'Your location will be broadcast to friends who share location with you.'}
            </Text>

            {/* Yourself row */}
            <TouchableOpacity
              style={[styles.pickerRow, !myLocation && styles.pickerRowDisabled]}
              disabled={!myLocation}
              onPress={() => handlePickSosTarget('Yourself', myLocation?.lat ?? 0, myLocation?.lng ?? 0)}
              accessibilityRole="button"
              accessibilityLabel={myLocation ? 'SOS for yourself using your GPS location' : 'Location unavailable'}
              accessibilityState={{ disabled: !myLocation }}
            >
              <Ionicons name="person" size={22} color={colors.textMuted} style={styles.pickerRowEmoji} />
              <View style={styles.pickerRowBody}>
                <Text style={[styles.pickerRowName, !myLocation && styles.pickerRowNameDisabled]}>
                  {myLocation ? 'Yourself' : 'Location unavailable – cannot broadcast'}
                </Text>
                <Text style={styles.pickerRowSub}>{myLocation ? 'Using your GPS location' : 'Enable location permissions to use this option'}</Text>
              </View>
              {myLocation && <Ionicons name="chevron-forward" size={20} color="#444444" style={{ marginLeft: 8 }} />}
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
                  <Ionicons name="car" size={22} color={colors.textMuted} style={styles.pickerRowEmoji} />
                  <View style={styles.pickerRowBody}>
                    <Text style={styles.pickerRowName}>{name}</Text>
                    <Text style={styles.pickerRowSub}>{m.speedKph.toFixed(0)} km/h · {formatElapsed(m.receivedAt)}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color="#444444" style={{ marginLeft: 8 }} />
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
      <Modal
        transparent
        visible={showSosConfirm}
        animationType="fade"
        onRequestClose={() => { setShowSosConfirm(false); setPendingSosCoord(null); setPendingSosName(''); }}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <MaterialIcons name="sos" size={20} color={colors.accent} />
              <Text style={[styles.modalTitle, { marginBottom: 0 }]}>Send SOS Alert?</Text>
            </View>
            <Text style={styles.modalBody}>
              {pendingSosName ? `This will broadcast ${pendingSosName}'s location` : "This will broadcast your location"} to {groupId ? 'all convoy members' : 'your friends with location sharing'} as an emergency alert.
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
        isInMotion={isInMotion}
        onSelect={handleHazardSelect}
        onClose={closeHazardPicker}
      />

      {/* Hazard report modal — full form with severity, note, and GPS coords.
          isInMotion restricts the type grid and hides severity/note per Req 31.1/31.2,
          same threshold as HazardPicker above. */}
      {/* isInMotion here is deliberately `mySpeedKph > 5` (kph), NOT the shared
          isInMotion value — deriveMotionState's threshold is 5 mph (~8 kph), and
          this modal's stricter cutoff is pre-existing behavior kept as-is. */}
      <HazardReportModal
        visible={showHazardModal}
        onClose={closeHazardModal}
        lat={hazardModalCoords?.lat ?? null}
        lng={hazardModalCoords?.lng ?? null}
        isInMotion={mySpeedKph > 5}
      />

      {/* Route planning modal */}
      <Modal
        transparent
        visible={showRouteModal}
        animationType="slide"
        onRequestClose={() => setShowRouteModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalBox, styles.routeModalBox]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Ionicons name="map" size={20} color={colors.text} />
              <Text style={[styles.modalTitle, { marginBottom: 0 }]}>Plan Route</Text>
            </View>
            <View style={styles.routeInputRow}>
              <TextInput
                style={styles.routeInput}
                placeholder="Enter destination"
                placeholderTextColor={colors.textSubtle}
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

            {/* Req 22.1: Scenic route preference toggle on the route calculation screen */}
            <View style={styles.scenicToggleRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <MaterialCommunityIcons name="pine-tree" size={16} color={colors.success} />
                <Text style={styles.scenicToggleLabel}>Scenic route</Text>
              </View>
              <Switch
                value={scenicRouting}
                onValueChange={(v) => setSettings({ scenicRouting: v })}
                accessibilityRole="switch"
                accessibilityLabel="Scenic routing preference"
              />
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
                      {selectedRouteIdx === idx && <Ionicons name="checkmark" size={18} color={colors.accent} />}
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {routeCoords.length > 0 && routeAlternatives.length > 0 && (
              <TouchableOpacity
                style={styles.routeClearBtn}
                onPress={() => { setRouteCoords([]); setRouteCongestionTiers([]); setRouteAlternatives([]); setRouteDestInput(''); setPostedSpeedLimitKph(null); activeDestRef.current = null; activeRouteSegmentsRef.current = { coords: [], segmentsKph: [] }; }}
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
            onPress={() => drivingModeServiceRef.current?.setManualActive(false)}
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
        onPress={noopBannerPress}
      />

      {/* Scenic-vs-fastest route picker — offered after picking a destination from
          the top search bar (see calculateRouteToDestination's offerRouteChoice).
          Reuses handleSelectRouteAlt so choosing here draws the same route the
          Plan Route modal's own picker would. */}
      <Modal
        transparent
        visible={showScenicSelector}
        animationType="slide"
        onRequestClose={() => setShowScenicSelector(false)}
      >
        <View style={styles.scenicSelectorOverlay}>
          <ScenicRouteSelector
            routes={scenicSelectorRoutes}
            selectedIndex={selectedRouteIdx}
            onSelect={handleSelectRouteAlt}
            onConfirm={closeScenicSelector}
            onDismiss={closeScenicSelector}
          />
        </View>
      </Modal>

      {/* First-visit spotlight tutorial (PTT / member list / hazard report).
          Visibility + "already seen" gating: see the mount effect above and
          CoachMarkOverlay's own onComplete-triggered SecureStore write. */}
      <CoachMarkOverlay
        visible={showCoachMarks}
        onComplete={completeCoachMarks}
      />
    </View>
  );
}

const SEARCH_SIDE_MARGIN = 64; // leaves room for re-center (left) and badge (right)

function makeStyles(colors: ThemeColors) {
return StyleSheet.create({
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
  badgeOnline: { backgroundColor: colors.success },
  badgeOffline: { backgroundColor: colors.textSubtle },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  // White-on-success fails contrast against the dark theme's bright green
  // (~2.3:1) — colors.success is bright enough in dark mode that light text
  // doesn't read reliably. Dark text passes comfortably in both themes.
  badgeOnlineText: { color: '#0A0A0A' },

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

  // Map data unavailable badge — top-right, below the map-style button (Req 4.4)
  mapDataBadgeWrap: {
    position: 'absolute',
    right: 12,
    alignItems: 'flex-end',
    zIndex: 10,
  },

  // Re-center — top-left
  recenterBtn: {
    position: 'absolute',
    left: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
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
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: colors.textSubtle,
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
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.warning,
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
    backgroundColor: colors.card,
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

  // Fuel banner — bottom offset is supplied inline (insets.bottom + 274) so it clears
  // the quick-action pill rows regardless of device safe-area inset.
  fuelBannerWrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 8,
  },
  sosBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.accent,
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
    backgroundColor: colors.textSubtle,
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
    backgroundColor: colors.accent,
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
    backgroundColor: colors.warning,
  },
  hazardAlertText: { color: '#FEF3C7', fontSize: 13 },
  alertBannerTexts: { flex: 1 },
  alertText: { color: '#F0F0F0', fontSize: 13 },
  // hazardBanner's background stays a fixed dark translucent chip regardless of
  // theme (it floats over the map), so this dismiss glyph stays fixed too.
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
    backgroundColor: colors.success,
  },
  // rallyBanner's background stays fixed dark regardless of theme (same as hazardBanner above).
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
    // 92%-opacity tint of the themed bg color (colors.bg is a 7-char hex, so
    // appending an alpha channel keeps this a themed surface instead of a
    // fixed-dark literal — needed since this panel's text below now follows
    // colors.text/textMuted).
    backgroundColor: `${colors.bg}eb`,
    overflow: 'hidden',
    paddingTop: 4,
    paddingHorizontal: 16,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
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
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  panelCollapsedChevron: {
    color: colors.textMuted,
    fontSize: 18,
    fontWeight: '600',
  },
  miniPttBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniPttBtnActive: {
    backgroundColor: 'rgba(220, 20, 60, 0.25)',
    borderColor: colors.accent,
  },
  panelTabRow: {
    flexDirection: 'row',
    marginBottom: 8,
    borderRadius: 8,
    backgroundColor: colors.card,
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
  panelTabActive: { backgroundColor: colors.accent },
  panelTabText: { color: colors.textSubtle, fontSize: 11, fontWeight: '600' },
  // panelTabActive's background is the fixed-value accent color, so its active
  // label stays fixed white for contrast rather than colors.text.
  panelTabTextActive: { color: '#FFFFFF' },
  panelConnecting: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  panelHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.textSubtle,
    alignSelf: 'center',
    marginBottom: 8,
  },
  panelTitle: { color: colors.text, fontWeight: '700', marginBottom: 8, fontSize: 13 },
  memberRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, minHeight: 36 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  dotOnline: { backgroundColor: colors.success },
  dotOffline: { backgroundColor: colors.textSubtle },
  memberText: { color: colors.text, flex: 1, fontSize: 13 },
  memberDetail: { color: colors.textMuted, fontSize: 12 },
  emptyText: { color: colors.textSubtle, fontSize: 13, textAlign: 'center', marginTop: 8 },

  // SOS confirm modal
  modalOverlay: { flex: 1, backgroundColor: '#00000099', alignItems: 'center', justifyContent: 'center' },
  // Bottom-sheet backdrop for ScenicRouteSelector, which renders its own rounded-top
  // "sheet" card and expects to be pinned to the bottom rather than centered like
  // modalOverlay above.
  scenicSelectorOverlay: { flex: 1, backgroundColor: '#00000099', justifyContent: 'flex-end' },
  modalBox: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 24,
    marginHorizontal: 32,
    borderWidth: 2,
    borderColor: colors.accent,
  },
  modalTitle: { color: colors.text, fontSize: 20, fontWeight: '800', marginBottom: 12 },
  modalBody: { color: colors.textMuted, fontSize: 14, lineHeight: 20, marginBottom: 20 },
  modalActions: { flexDirection: 'row', gap: 12 },
  modalCancel: { flex: 1, paddingVertical: 12, borderRadius: 8, backgroundColor: colors.border, alignItems: 'center' },
  modalCancelText: { color: colors.text, fontWeight: '600' },
  modalConfirm: { flex: 1, paddingVertical: 12, borderRadius: 8, backgroundColor: colors.accent, alignItems: 'center', borderWidth: 2, borderColor: '#FF8080' },
  modalConfirmText: { color: '#fff', fontWeight: '900', fontSize: 15 },

  // Person picker modal
  pickerBox: { borderColor: colors.accent, paddingHorizontal: 20, paddingVertical: 24, width: '100%' },
  pickerSubtitle: { color: colors.textMuted, fontSize: 13, lineHeight: 18, marginBottom: 16 },
  pickerDivider: { height: 1, backgroundColor: colors.border, marginVertical: 8 },
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
  pickerRowName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  pickerRowNameDisabled: { color: colors.textSubtle },
  pickerRowDisabled: { opacity: 0.5 },
  pickerRowSub: { color: colors.textSubtle, fontSize: 12, marginTop: 2 },
  pickerRowArrow: { color: colors.textSubtle, fontSize: 22, marginLeft: 8 },

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
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.textSubtle,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 8,
    marginTop: 8,
  },
  fabMainOpen: { borderColor: colors.accent },
  fabMainIcon: { fontSize: 26 },
  fabItem: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.textSubtle,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
    marginTop: 8,
  },
  fabItemIcon: { fontSize: 22 },
  fabItemText: { color: colors.text, fontWeight: '800', fontSize: 11 },
  fabItemActive: { borderColor: colors.accent, backgroundColor: '#1A0505' },
  fabSosItem: { borderColor: colors.accent },
  fabSosCancelItem: { borderColor: colors.border, backgroundColor: colors.border },
  fabPttItem: { borderColor: colors.accent },
  fabPttItemActive: { backgroundColor: '#8B0000', borderColor: '#FF4040' },
  fabPttItemUnavailable: { backgroundColor: colors.border, borderColor: '#555', opacity: 0.6 },
  fabPttLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },

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
  scenicToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  scenicToggleLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
  routeInput: {
    flex: 1,
    backgroundColor: colors.bg,
    color: colors.text,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    borderWidth: 1,
    borderColor: colors.border,
  },
  routeSearchBtn: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  routeSearchBtnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  routeAlts: { marginBottom: 16 },
  routeAltsLabel: { color: colors.textSubtle, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, marginBottom: 8 },
  routeAltRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 6,
  },
  routeAltRowActive: { borderColor: colors.accent, backgroundColor: '#1A0505' },
  routeAltBody: { flex: 1 },
  routeAltLabel: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },
  routeAltLabelActive: { color: colors.accent },
  routeAltMeta: { color: colors.textSubtle, fontSize: 12, marginTop: 2 },
  routeAltCheck: { color: colors.accent, fontSize: 18, fontWeight: '900' },
  routeClearBtn: { paddingVertical: 10, alignItems: 'center', marginBottom: 12 },
  routeClearText: { color: colors.textSubtle, fontSize: 13, textDecorationLine: 'underline' },

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
    borderTopColor: colors.accent,
    zIndex: 15,
  },
  drivingSpeedBox: {
    alignItems: 'center',
    marginRight: 20,
    minWidth: 64,
  },
  // drivingOverlay's background is a fixed dark bar regardless of theme (full-bleed
  // driving-mode HUD, meant to always read like a dashboard readout), so its text
  // stays fixed light/gray rather than following colors.text/textSubtle/textMuted.
  drivingSpeedValue: { color: '#F0F0F0', fontSize: 44, fontWeight: '900', lineHeight: 48 },
  drivingSpeedUnit: { color: '#555555', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  drivingInfo: { flex: 1 },
  drivingTitle: { color: colors.accent, fontSize: 12, fontWeight: '800', letterSpacing: 2 },
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

  // Offline / connection-lost banner — top offset supplied inline (insets.top)
  offlineBanner: {
    position: 'absolute',
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
    borderColor: colors.accent,
  },
  pttStandaloneBtn: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: colors.accent,
    shadowColor: colors.accent,
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
    borderColor: colors.textSubtle,
    opacity: 0.5,
    shadowOpacity: 0,
  },
  pttStandaloneIcon: { fontSize: 30 },
  pttStandaloneLabel: {
    color: colors.textSubtle,
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
    backgroundColor: colors.card,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#F59E0B44',
    borderLeftWidth: 4,
    borderLeftColor: colors.warning,
    zIndex: 25,
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

  announcementBanner: {
    position: 'absolute',
    top: 0,
    left: 16,
    right: 16,
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    zIndex: 26,
    shadowColor: colors.accent,
    shadowOpacity: 0.6,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 14,
  },
  // announcementBanner's background is the fixed-value accent color, so its
  // text stays fixed white for contrast rather than colors.text.
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
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 12,
  },
  quickActionPillText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
  },

  // Weather pill — top-left overlay
  weatherPill: {
    position: 'absolute',
    left: 12,
    backgroundColor: colors.card,
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: colors.border,
    zIndex: 10,
  },
  weatherPillText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
  },
});
}

function makeOverlayStyles(colors: ThemeColors) {
return StyleSheet.create({
  hazardCallout: {
    backgroundColor: colors.card,
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
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 4,
  },
  hazardCalloutSub: {
    color: colors.textMuted,
    fontSize: 11,
    marginBottom: 2,
  },
  hazardVoteRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  hazardVoteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  hazardVoteText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  hazardQuickPill: {
    borderColor: colors.warning,
    backgroundColor: '#1C1000',
    flex: 1,
  },
});
}
