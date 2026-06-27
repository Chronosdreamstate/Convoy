import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Alert,
} from 'react-native';
import MapView, { Marker, PROVIDER_DEFAULT, Polyline } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ExpoLocation from 'expo-location';
import { useRouter } from 'expo-router';

const DEFAULT_REGION = {
  latitude: 37.7749,
  longitude: -122.4194,
  latitudeDelta: 0.08,
  longitudeDelta: 0.08,
};

const DEMO_ROUTES: { key: string; coords: { latitude: number; longitude: number }[] }[] = [
  {
    key: 'route-a',
    coords: [
      { latitude: 37.790, longitude: -122.430 },
      { latitude: 37.785, longitude: -122.420 },
      { latitude: 37.778, longitude: -122.415 },
      { latitude: 37.772, longitude: -122.408 },
      { latitude: 37.765, longitude: -122.400 },
    ],
  },
  {
    key: 'route-b',
    coords: [
      { latitude: 37.788, longitude: -122.432 },
      { latitude: 37.783, longitude: -122.422 },
      { latitude: 37.776, longitude: -122.417 },
      { latitude: 37.770, longitude: -122.410 },
      { latitude: 37.763, longitude: -122.402 },
    ],
  },
  {
    key: 'route-c',
    coords: [
      { latitude: 37.786, longitude: -122.434 },
      { latitude: 37.781, longitude: -122.424 },
      { latitude: 37.774, longitude: -122.419 },
      { latitude: 37.768, longitude: -122.412 },
      { latitude: 37.761, longitude: -122.404 },
    ],
  },
];

const MARKER_EMOJIS = ['🚗', '🚙', '🏎️'];

function interpolateRoute(
  coords: { latitude: number; longitude: number }[],
  t: number,
): { latitude: number; longitude: number } {
  const clamped = Math.max(0, Math.min(1, t));
  const total = coords.length - 1;
  const scaled = clamped * total;
  const idx = Math.min(Math.floor(scaled), total - 1);
  const frac = scaled - idx;
  const a = coords[idx];
  const b = coords[idx + 1];
  return {
    latitude: a.latitude + (b.latitude - a.latitude) * frac,
    longitude: a.longitude + (b.longitude - a.longitude) * frac,
  };
}

const FEATURE_PILLS = [
  { icon: '🎙️', label: 'Push-to-talk radio' },
  { icon: '⚡', label: 'Real-time gap alerts' },
  { icon: '🗺️', label: 'Live convoy map' },
];

export default function GuestMapScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [initialRegion, setInitialRegion] = useState(DEFAULT_REGION);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const mapRef = useRef<MapView>(null);

  // Demo marker progress (0-1 per route), staggered starts
  const [markerProgress, setMarkerProgress] = useState<number[]>(
    DEMO_ROUTES.map((_, i) => i * 0.28),
  );

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const cardSlide = useRef(new Animated.Value(120)).current;
  const cardOpacity = useRef(new Animated.Value(0)).current;
  const pillScale = useRef(new Animated.Value(0.8)).current;

  // Pulse preview pill opacity
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.5, duration: 1100, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1100, useNativeDriver: true }),
      ]),
    ).start();
  }, [pulseAnim]);

  // Slide-up card + pill pop-in on mount
  useEffect(() => {
    Animated.parallel([
      Animated.spring(cardSlide, { toValue: 0, useNativeDriver: true, tension: 55, friction: 10 }),
      Animated.timing(cardOpacity, { toValue: 1, duration: 320, useNativeDriver: true }),
      Animated.spring(pillScale, { toValue: 1, useNativeDriver: true, tension: 80, friction: 8, delay: 180 }),
    ]).start();
  }, [cardSlide, cardOpacity, pillScale]);

  // Advance demo markers along routes
  useEffect(() => {
    const SPEED = 0.0025;
    const id = setInterval(() => {
      setMarkerProgress((prev) => prev.map((p) => (p + SPEED > 1 ? 0 : p + SPEED)));
    }, 80);
    return () => clearInterval(id);
  }, []);

  // Request location and center map
  useEffect(() => {
    let mounted = true;
    (async () => {
      const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
      if (!mounted) return;
      if (status !== 'granted') { setPermissionDenied(true); return; }
      const loc = await ExpoLocation.getCurrentPositionAsync({
        accuracy: ExpoLocation.Accuracy.Balanced,
      });
      if (!mounted) return;
      const region = {
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        latitudeDelta: 0.05,
        longitudeDelta: 0.05,
      };
      setInitialRegion(region);
      mapRef.current?.animateToRegion(region, 500);
    })();
    return () => { mounted = false; };
  }, []);

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_DEFAULT}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        showsUserLocation
      >
        {DEMO_ROUTES.map((route, i) => {
          const pos = interpolateRoute(route.coords, markerProgress[i]);
          return (
            <React.Fragment key={route.key}>
              <Polyline
                coordinates={route.coords}
                strokeColor="#DC143C55"
                strokeWidth={3}
                lineDashPattern={[6, 4]}
              />
              <Marker coordinate={pos} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
                <View style={styles.markerBubble}>
                  <Text style={styles.markerEmoji}>{MARKER_EMOJIS[i]}</Text>
                </View>
              </Marker>
            </React.Fragment>
          );
        })}
      </MapView>

      {/* Re-center button */}
      <TouchableOpacity
        style={[styles.recenterBtn, { top: insets.top + 8 }]}
        onPress={() =>
          ExpoLocation.getCurrentPositionAsync({ accuracy: ExpoLocation.Accuracy.Balanced })
            .then((loc) =>
              mapRef.current?.animateToRegion(
                { latitude: loc.coords.latitude, longitude: loc.coords.longitude, latitudeDelta: 0.05, longitudeDelta: 0.05 },
                500,
              ),
            )
            .catch(() => Alert.alert('Location unavailable', 'Enable location in Settings.'))
        }
        accessibilityRole="button"
        accessibilityLabel="Re-center map"
      >
        <Text style={styles.recenterText}>⊕</Text>
      </TouchableOpacity>

      {/* Preview Mode pill */}
      <Animated.View
        style={[
          styles.previewPill,
          { top: insets.top + 8, opacity: pulseAnim, transform: [{ scale: pillScale }] },
        ]}
      >
        <View style={styles.previewDot} />
        <Text style={styles.previewPillText}>👁 PREVIEW — Sign in to drive</Text>
      </Animated.View>

      {/* Map annotation bubbles */}
      <View style={[overlayStyles.annotationBubble, { top: insets.top + 72, left: 16 }]}>
        <Text style={overlayStyles.annotationText}>🎙️ Push-to-talk</Text>
      </View>
      <View style={[overlayStyles.annotationBubble, { top: insets.top + 120, alignSelf: 'center', left: '35%' }]}>
        <Text style={overlayStyles.annotationText}>⚡ Live gaps</Text>
      </View>
      <View style={[overlayStyles.annotationBubble, { top: insets.top + 72, right: 16 }]}>
        <Text style={overlayStyles.annotationText}>📍 Member tracking</Text>
      </View>

      {/* Location denied card */}
      {permissionDenied && (
        <View style={styles.locationCard}>
          <Text style={styles.locationCardIcon}>📍</Text>
          <Text style={styles.locationCardTitle}>Enable Location</Text>
          <Text style={styles.locationCardBody}>
            Allow location access so Convoy can center the map on you and share your position with your group.
          </Text>
          <TouchableOpacity
            style={styles.locationCardBtn}
            onPress={() =>
              Alert.alert(
                'Location Access',
                'Open Settings → Privacy → Location Services → Convoy, then set to "While Using App".',
              )
            }
            accessibilityRole="button"
            accessibilityLabel="Open location settings"
          >
            <Text style={styles.locationCardBtnText}>Open Settings</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Bottom CTA card */}
      <Animated.View
        style={[
          styles.card,
          {
            bottom: Math.max(insets.bottom, 16) + 16,
            transform: [{ translateY: cardSlide }],
            opacity: cardOpacity,
          },
        ]}
      >
        <Text style={overlayStyles.headline}>🏁 Drive with your crew</Text>
        <Text style={styles.logo}>CONVOY</Text>
        <Text style={styles.tagline}>The app built for car enthusiasts.</Text>

        <View style={overlayStyles.checkList}>
          <Text style={overlayStyles.checkItem}>✓  Real-time convoy tracking</Text>
          <Text style={overlayStyles.checkItem}>✓  Push-to-talk radio</Text>
          <Text style={overlayStyles.checkItem}>✓  Live gap alerts</Text>
        </View>

        <TouchableOpacity
          style={styles.createBtn}
          onPress={() => router.push('/(auth)/welcome')}
          accessibilityLabel="Create free Convoy account"
          accessibilityRole="button"
        >
          <Text style={styles.createBtnText}>Create Free Account</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.signInBtn}
          onPress={() => router.push('/(auth)/welcome')}
          accessibilityLabel="Sign in to Convoy"
          accessibilityRole="button"
        >
          <Text style={styles.signInText}>
            Already have an account?{' '}
            <Text style={styles.signInTextBold}>Sign In</Text>
          </Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  markerBubble: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#1C1C1Cf2',
    borderWidth: 1.5,
    borderColor: '#DC143C',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#DC143C',
    shadowOpacity: 0.5,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  markerEmoji: { fontSize: 15 },

  recenterBtn: {
    position: 'absolute',
    left: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#1C1C1Cf5',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
    zIndex: 10,
  },
  recenterText: { fontSize: 22, color: '#FFFFFF' },

  previewPill: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0A0A0Aee',
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#DC143C70',
    gap: 6,
    zIndex: 10,
  },
  previewDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#DC143C',
  },
  previewPillText: {
    color: '#CCCCCC',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
  },

  locationCard: {
    position: 'absolute',
    top: '30%',
    left: 32,
    right: 32,
    backgroundColor: '#1C1C1Cf5',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
  locationCardIcon: { fontSize: 36, marginBottom: 12 },
  locationCardTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  locationCardBody: {
    color: '#888888',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
    marginBottom: 20,
  },
  locationCardBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 32,
  },
  locationCardBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },

  card: {
    position: 'absolute',
    left: 16,
    right: 16,
    backgroundColor: '#0A0A0Af8',
    borderRadius: 24,
    paddingTop: 24,
    paddingBottom: 20,
    paddingHorizontal: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    shadowColor: '#000',
    shadowOpacity: 0.65,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  logo: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: 8,
    marginBottom: 4,
  },
  tagline: {
    color: '#666666',
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 0.3,
    marginBottom: 18,
  },

  featureRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 20,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  featurePill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1C1C1C',
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    gap: 5,
  },
  featureIcon: { fontSize: 13 },
  featureLabel: { color: '#CCCCCC', fontSize: 12, fontWeight: '600' },

  createBtn: {
    width: '100%',
    backgroundColor: '#DC143C',
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    shadowColor: '#DC143C',
    shadowOpacity: 0.45,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  createBtnText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 16,
    letterSpacing: 0.3,
  },

  signInBtn: { paddingVertical: 4 },
  signInText: { color: '#555555', fontSize: 13, fontWeight: '400' },
  signInTextBold: { color: '#999999', fontWeight: '700' },
});

const overlayStyles = StyleSheet.create({
  headline: {
    color: '#AAAAAA',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  checkList: {
    alignSelf: 'stretch',
    marginBottom: 20,
    gap: 6,
    paddingHorizontal: 8,
  },
  checkItem: {
    color: '#CCCCCC',
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 0.2,
  },

  annotationBubble: {
    position: 'absolute',
    backgroundColor: '#1C1C1C',
    borderRadius: 10,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderWidth: 0.5,
    borderColor: 'rgba(255,255,255,0.15)',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
    zIndex: 5,
  },
  annotationText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
  },
});
