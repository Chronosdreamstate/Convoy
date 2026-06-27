import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ExpoLocation from 'expo-location';
import { useRouter } from 'expo-router';
import LocationPermissionPrescreen from '../../components/LocationPermissionPrescreen';
import { apiClient } from '../../services/apiClient';
import { useAuthStore } from '../../stores/authStore';
import { useSettingsStore } from '../../stores/settingsStore';

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

function getGreeting(displayName: string): string {
  const firstName = displayName.split(' ')[0];
  const hour = new Date().getHours();
  if (hour < 12) return `Good morning, ${firstName} 👋`;
  if (hour < 17) return `Good afternoon, ${firstName} 👋`;
  return `Good evening, ${firstName} 👋`;
}

export default function IdleMapScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const mapRef = useRef<MapView>(null);
  const user = useAuthStore((s) => s.user);
  const mapStyle = useSettingsStore((s) => s.mapStyle);

  const [initialRegion, setInitialRegion] = useState(DEFAULT_REGION);
  const [locating, setLocating] = useState(true);
  const [showPrescreen, setShowPrescreen] = useState(false);
  const [nearbyGroups, setNearbyGroups] = useState<NearbyGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<NearbyGroup | null>(null);
  const [showSuggestion, setShowSuggestion] = useState(false);
  const [speedKph, setSpeedKph] = useState<number | null>(null);
  const [headingDeg, setHeadingDeg] = useState<number>(0);
  const [hudVisible, setHudVisible] = useState(true);

  const isSuggestionShown = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const locationSubRef = useRef<ExpoLocation.LocationSubscription | null>(null);

  // Animations
  const pulseOpacity = useRef(new Animated.Value(1)).current;
  const pulseScale = useRef(new Animated.Value(1)).current;
  const toastAnim = useRef(new Animated.Value(0)).current;
  const [showToast, setShowToast] = useState(true);
  const suggestionAnim = useRef(new Animated.Value(0)).current;
  const selectedCardAnim = useRef(new Animated.Value(0)).current;

  // GPS locating pulse
  useEffect(() => {
    if (!locating) return;
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
  }, [locating, pulseOpacity, pulseScale]);

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
          const spd = loc.coords.speed;
          if (spd !== null && spd >= 0) setSpeedKph(Math.round(spd * 3.6));
          if (loc.coords.heading !== null && loc.coords.heading >= 0) {
            setHeadingDeg(loc.coords.heading);
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
            >
              <View style={styles.convoyMarker}>
                <Text style={styles.convoyMarkerText}>{group.memberCount}</Text>
              </View>
            </Marker>
          ) : null,
        )}
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

      {/* Time-based greeting */}
      {user && (
        <View style={[styles.greetingPill, { top: insets.top + 12 }]} pointerEvents="none">
          <Text style={styles.greetingText}>{getGreeting(user.displayName)}</Text>
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
          <Text style={styles.nearbyPillText}>
            🚗 {nearbyGroups.length} convoy{nearbyGroups.length !== 1 ? 's' : ''} near you
          </Text>
        </TouchableOpacity>
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
        >
          <Text style={styles.hudSpeed}>
            {speedKph !== null ? `${speedKph}` : '—'}
          </Text>
          <Text style={styles.hudUnit}>km/h</Text>
          <Animated.Text
            style={[styles.hudCompass, { transform: [{ rotate: `${headingDeg}deg` }] }]}
          >
            ↑
          </Animated.Text>
        </TouchableOpacity>
      )}

      {!hudVisible && (
        <TouchableOpacity
          style={[styles.hudToggle, { top: insets.top + 12, right: 12 }]}
          onPress={() => setHudVisible(true)}
        >
          <Text style={styles.recenterText}>🧭</Text>
        </TouchableOpacity>
      )}

      {/* Re-center button */}
      <TouchableOpacity
        style={[styles.recenterBtn, { top: hudVisible ? insets.top + 100 : insets.top + 64 }]}
        onPress={recenter}
        accessibilityRole="button"
        accessibilityLabel="Re-center map"
      >
        <Text style={styles.recenterText}>⊕</Text>
      </TouchableOpacity>

      {/* Idle engagement suggestion toast */}
      {showSuggestion && (
        <Animated.View style={[styles.suggestionToast, { bottom: cardHeight + 12, opacity: suggestionAnim }]}>
          <View style={styles.suggestionStrip} />
          <TouchableOpacity
            style={styles.suggestionContent}
            onPress={() => { setShowSuggestion(false); handleBrowseGroups(); }}
            activeOpacity={0.8}
          >
            <Text style={styles.suggestionText}>🚗 Ready to roll? Find a convoy near you</Text>
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
            <TouchableOpacity style={styles.joinBtn} onPress={() => handleJoinGroup(selectedGroup.id)}>
              <Text style={styles.joinBtnText}>Join →</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setSelectedGroup(null)} style={styles.dismissBtn}>
              <Text style={styles.dismissText}>✕</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      )}

      {/* Bottom CTA sheet */}
      <View style={[styles.bottomSheet, { height: cardHeight }]}>
        <View style={styles.sheetHandle} />
        <Text style={styles.sheetTitle}>🚗 Start or Join a Convoy</Text>

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
              >
                <Text style={styles.nearbyGroupName} numberOfLines={1}>{g.name}</Text>
                <View style={styles.memberPill}>
                  <Text style={styles.memberPillText}>{g.memberCount} 🚗</Text>
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {/* Empty state when no nearby groups */}
        {nearbyGroups.length === 0 && !locating && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyEmoji}>🛣️</Text>
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
          <Text style={styles.outlineBtnSubtitle}>Enter 8-digit code</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.ghostBtn} onPress={handleBrowseGroups} accessibilityRole="button">
          <Text style={styles.ghostBtnText}>🔍 Browse Groups →</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },

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

  // Convoy map markers
  convoyMarker: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#DC143C',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#FFFFFF',
    shadowColor: '#DC143C',
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

  // Greeting pill
  greetingPill: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: 'rgba(28,28,28,0.92)',
    borderRadius: 20,
    paddingVertical: 7,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    zIndex: 20,
  },
  greetingText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.2,
  },

  nearbyPill: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: '#1C1C1C',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    zIndex: 20,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
  nearbyPillText: {
    color: '#FFFFFF',
    fontSize: 13,
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
    borderColor: '#2A2A2A',
  },
  toastText: { color: '#FFFFFF', fontSize: 13, fontWeight: '500', letterSpacing: 0.2 },

  // Speed / Compass HUD
  hudCard: {
    position: 'absolute',
    width: 64,
    backgroundColor: 'rgba(28,28,28,0.92)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    alignItems: 'center',
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
    zIndex: 15,
  },
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
    color: '#DC143C',
    fontSize: 20,
    fontWeight: '700',
    marginTop: 4,
  },
  hudToggle: {
    position: 'absolute',
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#1C1C1C',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    zIndex: 15,
  },

  recenterBtn: {
    position: 'absolute',
    right: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#1C1C1C',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
    zIndex: 10,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  recenterText: { fontSize: 22, color: '#FFFFFF' },

  suggestionToast: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 8,
    zIndex: 30,
  },
  suggestionStrip: { width: 4, backgroundColor: '#DC143C' },
  suggestionContent: { flex: 1, paddingVertical: 14, paddingHorizontal: 14 },
  suggestionText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },

  // Selected group card (marker tap)
  selectedCard: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 25,
  },
  selectedCardInner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1C1C1C',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    padding: 14,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 10,
  },
  selectedCardName: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  selectedCardMeta: { color: '#888888', fontSize: 12, marginTop: 2 },
  joinBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginLeft: 10,
  },
  joinBtnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  dismissBtn: { paddingLeft: 10, paddingVertical: 4 },
  dismissText: { color: '#888888', fontSize: 16 },

  bottomSheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#0A0A0A',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: '#2A2A2A',
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
    backgroundColor: '#2A2A2A',
    alignSelf: 'center',
    marginBottom: 12,
  },
  sheetTitle: {
    color: '#FFFFFF',
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
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginRight: 10,
    minWidth: 120,
    maxWidth: 160,
    alignItems: 'flex-start',
  },
  nearbyGroupName: {
    color: '#FFFFFF',
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
  memberPillText: { color: '#DC143C', fontSize: 11, fontWeight: '600' },

  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingVertical: 8,
    marginBottom: 8,
  },
  emptyEmoji: { fontSize: 28, marginBottom: 4 },
  emptyTitle: { color: '#FFFFFF', fontSize: 14, fontWeight: '600', marginBottom: 2 },
  emptySubtitle: { color: '#888888', fontSize: 12 },

  primaryBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
    shadowColor: '#DC143C',
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  primaryBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', letterSpacing: 0.3 },
  btnSubtitle: { color: 'rgba(255,255,255,0.65)', fontSize: 12, fontWeight: '400', marginTop: 2 },
  outlineBtn: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#DC143C',
    marginBottom: 10,
  },
  outlineBtnText: { color: '#DC143C', fontSize: 16, fontWeight: '600', letterSpacing: 0.3 },
  outlineBtnSubtitle: { color: '#888888', fontSize: 12, fontWeight: '400', marginTop: 2 },
  ghostBtn: { alignItems: 'center', paddingVertical: 10 },
  ghostBtnText: { color: '#888888', fontSize: 14, fontWeight: '500' },
});
