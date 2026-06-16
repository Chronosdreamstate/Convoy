import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import MapView, { Marker, LongPressEvent, PROVIDER_DEFAULT } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '../../stores/authStore';
import { useLocationStore, MemberLocation } from '../../stores/locationStore';
import { rallyService, RallyPoint, SosPin } from '../../services/RallyService';
import DestinationSearch, { SearchResult } from '../../components/DestinationSearch';

interface GapAlert { memberId: string; distanceM: number }
interface SosAlert { pin: SosPin; memberName: string }

interface Props {
  groupId: string;
  accessToken: string;
  socketUrl: string;
  gapThresholdM?: number;
}

function formatElapsed(receivedAt: number): string {
  const s = Math.floor((Date.now() - receivedAt) / 1000);
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

export default function MapScreen({ groupId, accessToken, socketUrl }: Props) {
  const { user, token } = useAuthStore();
  const { memberLocations, updateMemberLocation, clearGroup } = useLocationStore();
  const insets = useSafeAreaInsets();

  const [gapAlerts, setGapAlerts]     = useState<GapAlert[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [rallyPoints, setRallyPoints] = useState<Map<string, RallyPoint>>(new Map());
  const [rallyAlert, setRallyAlert]   = useState<RallyPoint | null>(null);
  const [sosPins, setSosPins]         = useState<Map<string, SosPin>>(new Map());
  const [sosAlerts, setSosAlerts]     = useState<SosAlert[]>([]);
  const [mySosId, setMySosId]         = useState<string | null>(null);
  const [showSosConfirm, setShowSosConfirm] = useState(false);
  const [pendingSosCoord, setPendingSosCoord] = useState<{ lat: number; lng: number } | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const mapRef    = useRef<MapView>(null);

  // WebSocket
  useEffect(() => {
    if (!token || !groupId) return;
    const socket = io(socketUrl, { transports: ['websocket'], auth: { token, groupId } });
    socketRef.current = socket;
    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));
    socket.on('location:update', (d: { userId: string; lat: number; lng: number; heading: number; speed_kph: number; ts: number }) => {
      if (d.userId === user?.id) return;
      updateMemberLocation({ userId: d.userId, lat: d.lat, lng: d.lng, heading: d.heading, speedKph: d.speed_kph, ts: d.ts, receivedAt: Date.now() });
    });
    socket.on('gap:alert', (a: GapAlert) => setGapAlerts((p) => [...p.filter((x) => x.memberId !== a.memberId), a]));
    socket.on('rally:set', (r: RallyPoint) => { setRallyPoints((p) => new Map(p).set(r.id, r)); setRallyAlert(r); });
    socket.on('rally:cancelled', ({ rallyId }: { rallyId: string }) => { setRallyPoints((p) => { const n = new Map(p); n.delete(rallyId); return n; }); setRallyAlert((p) => p?.id === rallyId ? null : p); });
    socket.on('sos:alert', (pin: SosPin) => { setSosPins((p) => new Map(p).set(pin.id, pin)); const name = pin.userId === user?.id ? 'You' : `Member ${pin.userId.slice(0, 6)}`; setSosAlerts((p) => [...p, { pin, memberName: name }]); });
    socket.on('sos:cancelled', ({ sosId }: { sosId: string }) => { setSosPins((p) => { const n = new Map(p); n.delete(sosId); return n; }); setSosAlerts((p) => p.filter((a) => a.pin.id !== sosId)); if (mySosId === sosId) setMySosId(null); });
    return () => { socket.disconnect(); clearGroup(); };
  }, [token, groupId, socketUrl]);

  const recenter = useCallback(() => {
    mapRef.current?.animateToRegion({ latitude: 37.7749, longitude: -122.4194, latitudeDelta: 0.05, longitudeDelta: 0.05 }, 600);
  }, []);

  const handleLongPress = useCallback((e: LongPressEvent) => {
    if (!groupId) return;
    const { latitude: lat, longitude: lng } = e.nativeEvent.coordinate;
    Alert.alert('Meet Me Here', 'Broadcast this as a Rally Point to all group members?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Broadcast', onPress: async () => { try { await rallyService.broadcastRally(groupId, lat, lng); } catch { Alert.alert('Error', 'Could not broadcast rally point.'); } } },
    ]);
  }, [groupId]);

  const handleSosPress = useCallback(() => {
    setPendingSosCoord({ lat: 0, lng: 0 });
    setShowSosConfirm(true);
  }, []);

  const confirmSos = useCallback(async () => {
    setShowSosConfirm(false);
    if (!pendingSosCoord) return;
    try {
      const pin = groupId
        ? await rallyService.broadcastGroupSos(groupId, pendingSosCoord.lat, pendingSosCoord.lng)
        : await rallyService.broadcastStandaloneSos(pendingSosCoord.lat, pendingSosCoord.lng);
      setMySosId(pin.id);
    } catch { Alert.alert('Error', 'Could not send SOS.'); }
    setPendingSosCoord(null);
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

  const members    = Array.from(memberLocations.values());
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
        showsUserLocation
        followsUserLocation
        initialRegion={{ latitude: 37.7749, longitude: -122.4194, latitudeDelta: 0.1, longitudeDelta: 0.1 }}
        onLongPress={handleLongPress}
      >
        {members.map((m: MemberLocation) => (
          <Marker key={m.userId} coordinate={{ latitude: m.lat, longitude: m.lng }} title={`Member ${m.userId.slice(0, 6)}`} description={`${m.speedKph.toFixed(0)} km/h`} pinColor="#3b82f6" />
        ))}
        {rallies.map((r) => (
          <Marker key={r.id} coordinate={{ latitude: r.lat, longitude: r.lng }} title="Rally Point" description={r.address ?? undefined} pinColor="#22c55e" />
        ))}
        {sosPinList.map((s) => (
          <Marker key={s.id} coordinate={{ latitude: s.lat, longitude: s.lng }} title="SOS" pinColor="#ef4444" />
        ))}
      </MapView>

      {/* Floating search bar — centered top, clears connection badge */}
      <View style={[styles.searchWrapper, { top: topBase }]}>
        <DestinationSearch
          isOnline={isConnected}
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

      {/* SOS button — bottom-right, above member panel */}
      {user && (
        <View style={styles.sosContainer}>
          {mySosId
            ? <TouchableOpacity style={styles.sosCancelBtn} onPress={cancelMySos} accessibilityLabel="Cancel SOS"><Text style={styles.sosText}>CANCEL SOS</Text></TouchableOpacity>
            : <TouchableOpacity style={styles.sosBtn} onPress={handleSosPress} accessibilityLabel="Send SOS emergency alert"><Text style={styles.sosText}>SOS</Text></TouchableOpacity>
          }
        </View>
      )}

      {/* Gap alerts */}
      {gapAlerts.length > 0 && (
        <View style={styles.alertBanner}>
          {gapAlerts.map((a) => <Text key={a.memberId} style={styles.alertText}>⚠ Member {a.memberId.slice(0, 6)} is {(a.distanceM / 1000).toFixed(1)} km behind</Text>)}
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
        <Text style={styles.panelTitle}>Members ({members.length})</Text>
        <FlatList
          data={members}
          keyExtractor={(m) => m.userId}
          renderItem={({ item: m }) => {
            const isStale = Date.now() - m.receivedAt > staleMs;
            return (
              <View style={styles.memberRow}>
                <View style={[styles.dot, isStale ? styles.dotOffline : styles.dotOnline]} />
                <Text style={styles.memberText}>{m.userId.slice(0, 8)}…</Text>
                <Text style={styles.memberDetail}>{isStale ? formatElapsed(m.receivedAt) : `${m.speedKph.toFixed(0)} km/h`}</Text>
              </View>
            );
          }}
          ListEmptyComponent={<Text style={styles.emptyText}>No members yet</Text>}
        />
      </View>

      {/* SOS confirm modal */}
      <Modal transparent visible={showSosConfirm} animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>🆘 Send SOS Alert?</Text>
            <Text style={styles.modalBody}>This will immediately broadcast your location to all group members as an emergency alert.</Text>
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => { setShowSosConfirm(false); setPendingSosCoord(null); }}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirm} onPress={confirmSos}>
                <Text style={styles.modalConfirmText}>SEND SOS</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
  badgeOffline: { backgroundColor: '#6b7280' },
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

  // SOS button — bottom-right, above member panel
  sosContainer: {
    position: 'absolute',
    bottom: 240,
    right: 16,
    alignItems: 'flex-end',
    zIndex: 10,
  },
  sosBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#b91c1c',
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
    backgroundColor: '#6b7280',
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
    backgroundColor: '#dc2626cc',
    borderRadius: 8,
    padding: 10,
    zIndex: 8,
  },
  alertText: { color: '#fff', fontSize: 13 },
  rallyBanner: {
    position: 'absolute',
    bottom: 330,
    left: 12,
    right: 12,
    backgroundColor: '#15803ddd',
    borderRadius: 8,
    padding: 12,
    zIndex: 8,
  },
  rallyBannerText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  sosBanner: {
    position: 'absolute',
    left: 12,
    right: 80,
    backgroundColor: '#7f1d1d',
    borderRadius: 8,
    padding: 12,
    borderWidth: 2,
    borderColor: '#fca5a5',
    zIndex: 8,
  },
  sosBannerText: { color: '#fca5a5', fontSize: 14, fontWeight: '700', marginBottom: 4 },
  sosBannerDismiss: { color: '#fca5a5', fontSize: 12, textDecorationLine: 'underline' },

  // Member panel — dark card at bottom
  memberPanel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#0f172aee',
    maxHeight: 220,
    paddingTop: 8,
    paddingHorizontal: 16,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderTopColor: '#334155',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -2 },
    elevation: 8,
    zIndex: 5,
  },
  panelHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#475569',
    alignSelf: 'center',
    marginBottom: 8,
  },
  panelTitle: { color: '#f1f5f9', fontWeight: '700', marginBottom: 8, fontSize: 13 },
  memberRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, minHeight: 36 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  dotOnline: { backgroundColor: '#10b981' },
  dotOffline: { backgroundColor: '#6b7280' },
  memberText: { color: '#e2e8f0', flex: 1, fontSize: 13 },
  memberDetail: { color: '#94a3b8', fontSize: 12 },
  emptyText: { color: '#64748b', fontSize: 13, textAlign: 'center', marginTop: 8 },

  // SOS confirm modal
  modalOverlay: { flex: 1, backgroundColor: '#00000099', alignItems: 'center', justifyContent: 'center' },
  modalBox: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 24,
    marginHorizontal: 32,
    borderWidth: 2,
    borderColor: '#ef4444',
  },
  modalTitle: { color: '#f8fafc', fontSize: 20, fontWeight: '800', marginBottom: 12 },
  modalBody: { color: '#cbd5e1', fontSize: 14, lineHeight: 20, marginBottom: 20 },
  modalActions: { flexDirection: 'row', gap: 12 },
  modalCancel: { flex: 1, paddingVertical: 12, borderRadius: 8, backgroundColor: '#334155', alignItems: 'center' },
  modalCancelText: { color: '#f1f5f9', fontWeight: '600' },
  modalConfirm: { flex: 1, paddingVertical: 12, borderRadius: 8, backgroundColor: '#b91c1c', alignItems: 'center', borderWidth: 2, borderColor: '#fca5a5' },
  modalConfirmText: { color: '#fff', fontWeight: '900', fontSize: 15 },
});
