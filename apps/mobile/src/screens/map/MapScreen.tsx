import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  FlatList,
} from 'react-native';
import MapboxGL from '@rnmapbox/maps';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '../../stores/authStore';
import { useLocationStore, MemberLocation } from '../../stores/locationStore';
import { rallyService, RallyPoint, SosPin } from '../../services/RallyService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GapAlert {
  memberId: string;
  distanceM: number;
}

interface SosAlert {
  pin: SosPin;
  memberName: string;
}

interface Props {
  groupId: string;
  accessToken: string;
  socketUrl: string;
  gapThresholdM?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatElapsed(receivedAt: number): string {
  const s = Math.floor((Date.now() - receivedAt) / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

function MemberPin({ heading, isAdmin }: { heading: number; isAdmin?: boolean }) {
  return (
    <View style={[styles.pin, isAdmin && styles.adminPin]}>
      <Text style={styles.pinArrow}>↑</Text>
      <View style={[styles.pinArrowOverlay, { transform: [{ rotate: `${heading}deg` }] }]} />
    </View>
  );
}

function RallyPin() {
  return (
    <View style={styles.rallyPin}>
      <Text style={styles.rallyPinText}>🚩</Text>
    </View>
  );
}

function SosMarkerPin() {
  return (
    <View style={styles.sosPinMarker}>
      <Text style={styles.sosPinText}>🆘</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// MapScreen
// ---------------------------------------------------------------------------

export default function MapScreen({ groupId, accessToken, socketUrl }: Props) {
  const { user, token } = useAuthStore();
  const { memberLocations, updateMemberLocation, clearGroup } = useLocationStore();

  const [gapAlerts, setGapAlerts] = useState<GapAlert[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  // Rally state
  const [rallyPoints, setRallyPoints] = useState<Map<string, RallyPoint>>(new Map());
  const [rallyAlert, setRallyAlert] = useState<RallyPoint | null>(null);
  const [pendingLongPress, setPendingLongPress] = useState<{ lat: number; lng: number } | null>(null);

  // SOS state
  const [sosPins, setSosPins] = useState<Map<string, SosPin>>(new Map());
  const [sosAlerts, setSosAlerts] = useState<SosAlert[]>([]);
  const [mySosId, setMySosId] = useState<string | null>(null);
  const [showSosConfirm, setShowSosConfirm] = useState(false);
  const [pendingSosCoord, setPendingSosCoord] = useState<{ lat: number; lng: number } | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const cameraRef = useRef<MapboxGL.Camera>(null);
  const myLocationRef = useRef<{ lat: number; lng: number } | null>(null);

  MapboxGL.setAccessToken(accessToken);

  // ---------------------------------------------------------------------------
  // WebSocket connection (Req 8.2–8.5, 20.3, 25.1–25.6)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!token || !groupId) return;

    const socket = io(socketUrl, {
      transports: ['websocket'],
      auth: { token, groupId },
    });
    socketRef.current = socket;

    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));

    // Member location
    socket.on(
      'location:update',
      (data: { userId: string; lat: number; lng: number; heading: number; speed_kph: number; ts: number }) => {
        if (data.userId === user?.id) return;
        updateMemberLocation({
          userId: data.userId,
          lat: data.lat,
          lng: data.lng,
          heading: data.heading,
          speedKph: data.speed_kph,
          ts: data.ts,
          receivedAt: Date.now(),
        });
      },
    );

    socket.on('member:joined', ({ userId }: { userId: string }) => { void userId; });
    socket.on('member:left', ({ userId }: { userId: string }) => { void userId; });

    // Gap alert (Admin only, Req 24.2)
    socket.on('gap:alert', (alert: GapAlert) => {
      setGapAlerts((prev) => {
        const filtered = prev.filter((a) => a.memberId !== alert.memberId);
        return [...filtered, alert];
      });
    });

    // Rally events (Req 20.3, 20.5)
    socket.on('rally:set', (rally: RallyPoint) => {
      setRallyPoints((prev) => {
        const next = new Map(prev);
        next.set(rally.id, rally);
        return next;
      });
      setRallyAlert(rally);
    });

    socket.on('rally:cancelled', ({ rallyId }: { rallyId: string }) => {
      setRallyPoints((prev) => {
        const next = new Map(prev);
        next.delete(rallyId);
        return next;
      });
      setRallyAlert((prev) => (prev?.id === rallyId ? null : prev));
    });

    // SOS events (Req 25.4–25.6)
    socket.on('sos:alert', (pin: SosPin) => {
      setSosPins((prev) => {
        const next = new Map(prev);
        next.set(pin.id, pin);
        return next;
      });
      const memberName = pin.userId === user?.id ? 'You' : `Member ${pin.userId.slice(0, 6)}`;
      setSosAlerts((prev) => [...prev, { pin, memberName }]);
    });

    socket.on('sos:cancelled', ({ sosId }: { sosId: string }) => {
      setSosPins((prev) => {
        const next = new Map(prev);
        next.delete(sosId);
        return next;
      });
      setSosAlerts((prev) => prev.filter((a) => a.pin.id !== sosId));
      if (mySosId === sosId) setMySosId(null);
    });

    return () => {
      socket.disconnect();
      clearGroup();
    };
  }, [token, groupId, socketUrl]);

  // ---------------------------------------------------------------------------
  // Re-center
  // ---------------------------------------------------------------------------
  const recenter = useCallback(() => {
    cameraRef.current?.setCamera({ zoomLevel: 14, animationDuration: 600 });
  }, []);

  // ---------------------------------------------------------------------------
  // Long-press → Meet Me Here (Req 20.1)
  // ---------------------------------------------------------------------------
  const handleLongPress = useCallback(
    (feature: GeoJSON.Feature) => {
      if (!groupId) return;
      const [lng, lat] = (feature.geometry as GeoJSON.Point).coordinates;
      setPendingLongPress({ lat, lng });
      Alert.alert(
        'Meet Me Here',
        'Broadcast this location as a Rally Point to all group members?',
        [
          { text: 'Cancel', style: 'cancel', onPress: () => setPendingLongPress(null) },
          {
            text: 'Broadcast',
            onPress: async () => {
              try {
                await rallyService.broadcastRally(groupId, lat, lng);
              } catch {
                Alert.alert('Error', 'Could not broadcast rally point. Please try again.');
              } finally {
                setPendingLongPress(null);
              }
            },
          },
        ],
      );
    },
    [groupId],
  );

  // ---------------------------------------------------------------------------
  // SOS — tap confirmation then broadcast (Req 25.2–25.3)
  // ---------------------------------------------------------------------------
  const handleSosPress = useCallback(() => {
    // Capture current location for SOS
    const loc = myLocationRef.current ?? { lat: 0, lng: 0 };
    setPendingSosCoord(loc);
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
    } catch {
      Alert.alert('Error', 'Could not send SOS. Please try again.');
    }
    setPendingSosCoord(null);
  }, [groupId, pendingSosCoord]);

  const cancelMySos = useCallback(async () => {
    if (!mySosId || !groupId) return;
    try {
      await rallyService.cancelSos(groupId, mySosId);
      // The socket event will clean up local state
    } catch {
      Alert.alert('Error', 'Could not cancel SOS.');
    }
  }, [groupId, mySosId]);

  // ---------------------------------------------------------------------------
  // Rally alert → route to it (Req 20.4)
  // ---------------------------------------------------------------------------
  const handleRallyAlertTap = useCallback(() => {
    if (!rallyAlert) return;
    // TODO(router): trigger route calculation to rally point coordinates
    Alert.alert(
      'Rally Point',
      rallyAlert.address
        ? `Meet at: ${rallyAlert.address}`
        : `Meet at: ${rallyAlert.lat.toFixed(5)}, ${rallyAlert.lng.toFixed(5)}`,
      [{ text: 'OK', onPress: () => setRallyAlert(null) }],
    );
  }, [rallyAlert]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const members = Array.from(memberLocations.values());
  const staleThresholdMs = 30_000;
  const rallies = Array.from(rallyPoints.values());
  const sosPinList = Array.from(sosPins.values());

  return (
    <View style={styles.container}>
      {/* Map (Req 8.2–8.5, 20.3, 25.4) */}
      <MapboxGL.MapView
        style={styles.map}
        onLongPress={handleLongPress}
      >
        <MapboxGL.Camera
          ref={cameraRef}
          zoomLevel={13}
          followUserLocation
          followUserMode="course"
        />
        <MapboxGL.UserLocation visible animated />

        {/* Remote member pins */}
        {members.map((m: MemberLocation) => {
          const isStale = Date.now() - m.receivedAt > staleThresholdMs;
          return (
            <MapboxGL.PointAnnotation key={m.userId} id={m.userId} coordinate={[m.lng, m.lat]}>
              <View>
                <MemberPin heading={m.heading} />
                {isStale && <Text style={styles.staleLabel}>{formatElapsed(m.receivedAt)}</Text>}
              </View>
            </MapboxGL.PointAnnotation>
          );
        })}

        {/* Rally point pins (Req 20.3) */}
        {rallies.map((r) => (
          <MapboxGL.PointAnnotation key={r.id} id={`rally-${r.id}`} coordinate={[r.lng, r.lat]}>
            <RallyPin />
          </MapboxGL.PointAnnotation>
        ))}

        {/* SOS pins (Req 25.4) */}
        {sosPinList.map((s) => (
          <MapboxGL.PointAnnotation key={s.id} id={`sos-${s.id}`} coordinate={[s.lng, s.lat]}>
            <SosMarkerPin />
          </MapboxGL.PointAnnotation>
        ))}
      </MapboxGL.MapView>

      {/* Connection indicator */}
      <View style={[styles.badge, isConnected ? styles.badgeOnline : styles.badgeOffline]}>
        <Text style={styles.badgeText}>{isConnected ? 'LIVE' : 'OFFLINE'}</Text>
      </View>

      {/* Re-center button */}
      <TouchableOpacity style={styles.recenterBtn} onPress={recenter} accessibilityLabel="Re-center map">
        <Text style={styles.recenterText}>⊕</Text>
      </TouchableOpacity>

      {/* SOS button — always visible for authenticated members (Req 25.1, 40.1, 40.2) */}
      {user && (
        <View style={styles.sosContainer}>
          {mySosId ? (
            <TouchableOpacity
              style={styles.sosCancelBtn}
              onPress={cancelMySos}
              accessibilityLabel="Cancel SOS"
            >
              <Text style={styles.sosText}>CANCEL SOS</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.sosBtn}
              onPress={handleSosPress}
              accessibilityLabel="Send SOS emergency alert"
            >
              <Text style={styles.sosText}>SOS</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Gap alerts (Req 24.1–24.6) */}
      {gapAlerts.length > 0 && (
        <View style={styles.alertBanner}>
          {gapAlerts.map((a) => (
            <Text key={a.memberId} style={styles.alertText}>
              ⚠ Member {a.memberId.slice(0, 6)} is {(a.distanceM / 1000).toFixed(1)} km behind
            </Text>
          ))}
        </View>
      )}

      {/* Rally alert banner (Req 20.2–20.4) */}
      {rallyAlert && (
        <TouchableOpacity style={styles.rallyBanner} onPress={handleRallyAlertTap}>
          <Text style={styles.rallyBannerText}>
            🚩 Rally Point set{rallyAlert.address ? `: ${rallyAlert.address}` : ''} — Tap for directions
          </Text>
        </TouchableOpacity>
      )}

      {/* SOS in-app alerts (Req 25.5) */}
      {sosAlerts.length > 0 && (
        <View style={styles.sosBanner}>
          {sosAlerts.map((a) => (
            <Text key={a.pin.id} style={styles.sosBannerText}>
              🆘 EMERGENCY — {a.memberName} needs help!
            </Text>
          ))}
          <TouchableOpacity onPress={() => setSosAlerts([])}>
            <Text style={styles.sosBannerDismiss}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Member list panel (Req 8.5) */}
      <View style={styles.memberPanel}>
        <Text style={styles.panelTitle}>Members ({members.length})</Text>
        <FlatList
          data={members}
          keyExtractor={(m) => m.userId}
          renderItem={({ item: m }) => {
            const isStale = Date.now() - m.receivedAt > staleThresholdMs;
            return (
              <View style={styles.memberRow}>
                <View style={[styles.dot, isStale ? styles.dotOffline : styles.dotOnline]} />
                <Text style={styles.memberText}>{m.userId.slice(0, 8)}…</Text>
                <Text style={styles.memberDetail}>
                  {isStale ? formatElapsed(m.receivedAt) : `${m.speedKph.toFixed(0)} km/h`}
                </Text>
              </View>
            );
          }}
          ListEmptyComponent={<Text style={styles.emptyText}>No members yet</Text>}
        />
      </View>

      {/* SOS confirmation modal (Req 25.2) */}
      <Modal transparent visible={showSosConfirm} animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>🆘 Send SOS Alert?</Text>
            <Text style={styles.modalBody}>
              This will immediately broadcast your location to all group members as an emergency alert.
            </Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => { setShowSosConfirm(false); setPendingSosCoord(null); }}
              >
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

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1a1a2e' },
  map: { flex: 1 },

  // Member pins
  pin: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: '#3b82f6',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: '#fff',
  },
  adminPin: { backgroundColor: '#f59e0b' },
  pinArrow: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  pinArrowOverlay: { position: 'absolute', width: '100%', height: '100%' },
  staleLabel: { color: '#9ca3af', fontSize: 10, textAlign: 'center', marginTop: 2 },

  // Rally pin
  rallyPin: {
    width: 44, height: 44,
    alignItems: 'center', justifyContent: 'center',
  },
  rallyPinText: { fontSize: 28 },

  // SOS map pin
  sosPinMarker: {
    width: 44, height: 44,
    alignItems: 'center', justifyContent: 'center',
  },
  sosPinText: { fontSize: 28 },

  // Connection badge
  badge: {
    position: 'absolute', top: 48, right: 12,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8,
  },
  badgeOnline: { backgroundColor: '#10b981' },
  badgeOffline: { backgroundColor: '#6b7280' },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },

  // Re-center
  recenterBtn: {
    position: 'absolute', top: 48, left: 12,
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 4, elevation: 3,
  },
  recenterText: { fontSize: 24 },

  // SOS button (Req 25.1, 40.1, 40.2 — WCAG AA: white on #b91c1c contrast 5.9:1)
  sosContainer: {
    position: 'absolute', top: 104, right: 12,
  },
  sosBtn: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: '#b91c1c',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 3, borderColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 6, elevation: 6,
  },
  sosCancelBtn: {
    paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#6b7280',
    borderWidth: 2, borderColor: '#fff',
  },
  sosText: { color: '#fff', fontWeight: '900', fontSize: 13 },

  // Gap alert banner
  alertBanner: {
    position: 'absolute', bottom: 280, left: 12, right: 12,
    backgroundColor: '#dc2626cc', borderRadius: 8, padding: 10,
  },
  alertText: { color: '#fff', fontSize: 13 },

  // Rally alert banner (Req 20.2–20.4)
  rallyBanner: {
    position: 'absolute', bottom: 330, left: 12, right: 12,
    backgroundColor: '#15803ddd', borderRadius: 8, padding: 12,
  },
  rallyBannerText: { color: '#fff', fontSize: 13, fontWeight: '600' },

  // SOS in-app alert banner (Req 25.5)
  sosBanner: {
    position: 'absolute', top: 96, left: 12, right: 80,
    backgroundColor: '#7f1d1d', borderRadius: 8, padding: 12,
    borderWidth: 2, borderColor: '#fca5a5',
  },
  sosBannerText: { color: '#fca5a5', fontSize: 14, fontWeight: '700', marginBottom: 4 },
  sosBannerDismiss: { color: '#fca5a5', fontSize: 12, textDecorationLine: 'underline' },

  // Member panel
  memberPanel: {
    backgroundColor: '#0f172a', maxHeight: 220, padding: 12,
    borderTopWidth: 1, borderTopColor: '#334155',
  },
  panelTitle: { color: '#f1f5f9', fontWeight: '700', marginBottom: 8 },
  memberRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  dotOnline: { backgroundColor: '#10b981' },
  dotOffline: { backgroundColor: '#6b7280' },
  memberText: { color: '#e2e8f0', flex: 1, fontSize: 13 },
  memberDetail: { color: '#94a3b8', fontSize: 12 },
  emptyText: { color: '#64748b', fontSize: 13, textAlign: 'center', marginTop: 8 },

  // SOS confirmation modal
  modalOverlay: {
    flex: 1,
    backgroundColor: '#00000099',
    alignItems: 'center', justifyContent: 'center',
  },
  modalBox: {
    backgroundColor: '#1e293b',
    borderRadius: 12, padding: 24,
    marginHorizontal: 32,
    borderWidth: 2, borderColor: '#ef4444',
  },
  modalTitle: { color: '#f8fafc', fontSize: 20, fontWeight: '800', marginBottom: 12 },
  modalBody: { color: '#cbd5e1', fontSize: 14, lineHeight: 20, marginBottom: 20 },
  modalActions: { flexDirection: 'row', gap: 12 },
  modalCancel: {
    flex: 1, paddingVertical: 12, borderRadius: 8,
    backgroundColor: '#334155',
    alignItems: 'center',
  },
  modalCancelText: { color: '#f1f5f9', fontWeight: '600' },
  modalConfirm: {
    flex: 1, paddingVertical: 12, borderRadius: 8,
    backgroundColor: '#b91c1c',
    alignItems: 'center',
    borderWidth: 2, borderColor: '#fca5a5',
  },
  modalConfirmText: { color: '#fff', fontWeight: '900', fontSize: 15 },
});
