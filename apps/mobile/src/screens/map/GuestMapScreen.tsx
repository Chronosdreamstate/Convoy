import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Alert,
} from 'react-native';
import MapView, { PROVIDER_DEFAULT, Polyline } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ExpoLocation from 'expo-location';
import { useRouter } from 'expo-router';

const DEFAULT_REGION = {
  latitude: 37.7749,
  longitude: -122.4194,
  latitudeDelta: 0.1,
  longitudeDelta: 0.1,
};

// Sample convoy routes shown in guest mode to illustrate the app's value
const DEMO_ROUTES = [
  {
    key: 'route-a',
    coordinates: [
      { latitude: 37.790, longitude: -122.430 },
      { latitude: 37.785, longitude: -122.420 },
      { latitude: 37.778, longitude: -122.415 },
      { latitude: 37.772, longitude: -122.408 },
      { latitude: 37.765, longitude: -122.400 },
    ],
  },
  {
    key: 'route-b',
    coordinates: [
      { latitude: 37.788, longitude: -122.432 },
      { latitude: 37.783, longitude: -122.422 },
      { latitude: 37.776, longitude: -122.417 },
      { latitude: 37.770, longitude: -122.410 },
      { latitude: 37.763, longitude: -122.402 },
    ],
  },
  {
    key: 'route-c',
    coordinates: [
      { latitude: 37.786, longitude: -122.434 },
      { latitude: 37.781, longitude: -122.424 },
      { latitude: 37.774, longitude: -122.419 },
      { latitude: 37.768, longitude: -122.412 },
      { latitude: 37.761, longitude: -122.404 },
    ],
  },
];

export default function GuestMapScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [initialRegion, setInitialRegion] = useState(DEFAULT_REGION);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const mapRef = useRef<MapView>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Pulsing animation for the Preview Mode pill
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.5, duration: 1200, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1200, useNativeDriver: true }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [pulseAnim]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
      if (!mounted) return;
      if (status !== 'granted') {
        setPermissionDenied(true);
        return;
      }
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
        {/* Demo convoy routes — faded to hint at the app's core value */}
        {DEMO_ROUTES.map((route) => (
          <Polyline
            key={route.key}
            coordinates={route.coordinates}
            strokeColor="#DC143C60"
            strokeWidth={3}
            lineDashPattern={[8, 4]}
          />
        ))}
      </MapView>

      {/* Re-center button — top-left */}
      <TouchableOpacity
        style={[styles.recenterBtn, { top: insets.top + 8 }]}
        onPress={() => {
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
        }}
        accessibilityRole="button"
        accessibilityLabel="Re-center map"
      >
        <Text style={styles.recenterText}>⊕</Text>
      </TouchableOpacity>

      {/* Preview Mode pill — top center with pulse */}
      <Animated.View style={[styles.previewPill, { top: insets.top + 8, opacity: pulseAnim }]}>
        <Text style={styles.previewPillText}>Preview Mode — Sign in to join</Text>
      </Animated.View>

      {/* Location permission denied — centered overlay card */}
      {permissionDenied && (
        <View style={styles.locationCard}>
          <Text style={styles.locationCardIcon}>📍</Text>
          <Text style={styles.locationCardTitle}>Enable Location</Text>
          <Text style={styles.locationCardBody}>
            Allow location access so Convoy can center the map on you and share your position with your group.
          </Text>
          <TouchableOpacity
            style={styles.locationCardBtn}
            onPress={() => Alert.alert(
              'Location Access',
              'Open Settings → Privacy → Location Services → Convoy, then set to "While Using App".',
            )}
            accessibilityRole="button"
            accessibilityLabel="Open location settings"
          >
            <Text style={styles.locationCardBtnText}>Open Settings</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Bottom sign-in card */}
      <View style={[styles.card, { bottom: Math.max(insets.bottom, 16) + 16 }]}>
        <Text style={styles.logo}>CONVOY</Text>
        <View style={styles.divider} />

        <Text style={styles.tagline}>Sign in to join a convoy 🚗</Text>
        <Text style={styles.sub}>
          Share real-time location with your group, set rally points, and stay together on every road.
        </Text>

        <TouchableOpacity
          style={styles.signInBtn}
          onPress={() => router.push('/(auth)/welcome')}
          accessibilityLabel="Sign in to Convoy"
          accessibilityRole="button"
        >
          <Text style={styles.signInText}>Sign In</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

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

  previewPill: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: '#1C1C1Cee',
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#DC143C40',
    zIndex: 10,
  },
  previewPillText: {
    color: '#CCCCCC',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.3,
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
  locationCardTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
  },
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  locationCardBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },

  card: {
    position: 'absolute',
    left: 20,
    right: 20,
    backgroundColor: '#0A0A0Af2',
    borderRadius: 20,
    paddingVertical: 28,
    paddingHorizontal: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
  logo: {
    color: '#F0F0F0',
    fontSize: 32,
    fontWeight: '900',
    letterSpacing: 6,
    marginBottom: 12,
  },
  divider: {
    width: 40,
    height: 2,
    backgroundColor: '#DC143C',
    borderRadius: 1,
    marginBottom: 16,
  },
  tagline: {
    color: '#F0F0F0',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  sub: {
    color: '#888888',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
    marginBottom: 24,
  },
  signInBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 56,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#DC143C',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  signInText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
