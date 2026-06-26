import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import MapView, { PROVIDER_DEFAULT } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ExpoLocation from 'expo-location';
import { useRouter } from 'expo-router';
import LocationPermissionPrescreen from '../../components/LocationPermissionPrescreen';
import { apiClient } from '../../services/apiClient';

const DEFAULT_REGION = {
  latitude: 37.7749,
  longitude: -122.4194,
  latitudeDelta: 0.1,
  longitudeDelta: 0.1,
};

export default function IdleMapScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const mapRef = useRef<MapView>(null);
  const [initialRegion, setInitialRegion] = useState(DEFAULT_REGION);
  const [locating, setLocating] = useState(true);
  const [showPrescreen, setShowPrescreen] = useState(false);
  const [nearbyCount, setNearbyCount] = useState(0);
  const [showSuggestion, setShowSuggestion] = useState(false);
  const isSuggestionShown = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pulse animation: opacity + scale
  const pulseOpacity = useRef(new Animated.Value(1)).current;
  const pulseScale = useRef(new Animated.Value(1)).current;
  // Welcome toast
  const toastAnim = useRef(new Animated.Value(0)).current;
  const [showToast, setShowToast] = useState(true);
  // Idle suggestion toast
  const suggestionAnim = useRef(new Animated.Value(0)).current;

  // GPS pulse: opacity 1→0.3, scale 1→1.4
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

  // Welcome toast: fade in, hold, fade out
  useEffect(() => {
    Animated.sequence([
      Animated.timing(toastAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
      Animated.delay(2200),
      Animated.timing(toastAnim, { toValue: 0, duration: 400, useNativeDriver: true }),
    ]).start(() => setShowToast(false));
  }, [toastAnim]);

  // Idle engagement: show after 30s if not interacted
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

  const clearIdleTimer = () => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  };

  const fetchNearbyGroups = async (lat: number, lng: number) => {
    try {
      const res = await apiClient.get<{ groups: unknown[]; total: number }>(
        `/api/v1/groups?accessType=open&lat=${lat}&lng=${lng}&limit=10`,
      );
      setNearbyCount(res.groups?.length ?? 0);
    } catch {
      // non-fatal
    }
  };

  const requestLocationAndCenter = async (mounted: { current: boolean }) => {
    const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
    if (!mounted.current || status !== 'granted') {
      if (mounted.current) setLocating(false);
      return;
    }
    const loc = await ExpoLocation.getCurrentPositionAsync({
      accuracy: ExpoLocation.Accuracy.Balanced,
    });
    if (!mounted.current) return;
    const { latitude, longitude } = loc.coords;
    const region = { latitude, longitude, latitudeDelta: 0.05, longitudeDelta: 0.05 };
    setInitialRegion(region);
    mapRef.current?.animateToRegion(region, 500);
    setLocating(false);
    fetchNearbyGroups(latitude, longitude);
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
    return () => { mounted.current = false; };
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
    router.push('/group-browse');
  };

  const cardHeight = 260 + insets.bottom;

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
      />

      <View style={styles.dimOverlay} pointerEvents="none" />

      {/* GPS pulse while locating */}
      {locating && (
        <View style={styles.pulseWrapper} pointerEvents="none">
          <Animated.View
            style={[
              styles.pulseDot,
              { opacity: pulseOpacity, transform: [{ scale: pulseScale }] },
            ]}
          />
        </View>
      )}

      {/* Nearby convoy count pill */}
      {nearbyCount > 0 && (
        <TouchableOpacity
          style={[styles.nearbyPill, { top: insets.top + 12 }]}
          onPress={handleBrowseGroups}
          accessibilityRole="button"
          accessibilityLabel={`${nearbyCount} convoys near you, tap to browse`}
        >
          <Text style={styles.nearbyPillText}>🚗 {nearbyCount} convoy{nearbyCount !== 1 ? 's' : ''} near you</Text>
        </TouchableOpacity>
      )}

      {/* Welcome toast (only when no nearby pill) */}
      {showToast && nearbyCount === 0 && (
        <Animated.View
          style={[styles.toast, { top: insets.top + 12, opacity: toastAnim }]}
          pointerEvents="none"
        >
          <Text style={styles.toastText}>Tap below to start your convoy</Text>
        </Animated.View>
      )}

      {/* Re-center button */}
      <TouchableOpacity
        style={[styles.recenterBtn, { top: insets.top + 8 }]}
        onPress={recenter}
        accessibilityRole="button"
        accessibilityLabel="Re-center map"
      >
        <Text style={styles.recenterText}>⊕</Text>
      </TouchableOpacity>

      {/* Idle engagement suggestion toast */}
      {showSuggestion && (
        <Animated.View
          style={[styles.suggestionToast, { bottom: cardHeight + 12, opacity: suggestionAnim }]}
        >
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

      {/* Bottom CTA sheet */}
      <View style={[styles.bottomSheet, { height: cardHeight }]}>
        <View style={styles.sheetHandle} />
        <Text style={styles.sheetTitle}>🚗 Start or Join a Convoy</Text>

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
          onPress={() => { clearIdleTimer(); router.push('/join'); }}
          accessibilityRole="button"
          accessibilityLabel="Join a group with a code"
        >
          <Text style={styles.outlineBtnText}>Join with Code</Text>
          <Text style={styles.outlineBtnSubtitle}>Enter 8-digit code</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.ghostBtn}
          onPress={handleBrowseGroups}
          accessibilityRole="button"
          accessibilityLabel="Browse nearby groups"
        >
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
  toastText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 0.2,
  },

  recenterBtn: {
    position: 'absolute',
    left: 12,
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
  suggestionStrip: {
    width: 4,
    backgroundColor: '#DC143C',
  },
  suggestionContent: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 14,
  },
  suggestionText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },

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
    marginBottom: 16,
  },
  sheetTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 0.3,
    marginBottom: 14,
    textAlign: 'center',
  },
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
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  btnSubtitle: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 12,
    fontWeight: '400',
    marginTop: 2,
  },
  outlineBtn: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#DC143C',
    marginBottom: 10,
  },
  outlineBtnText: {
    color: '#DC143C',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  outlineBtnSubtitle: {
    color: '#888888',
    fontSize: 12,
    fontWeight: '400',
    marginTop: 2,
  },
  ghostBtn: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  ghostBtnText: {
    color: '#888888',
    fontSize: 14,
    fontWeight: '500',
  },
});
