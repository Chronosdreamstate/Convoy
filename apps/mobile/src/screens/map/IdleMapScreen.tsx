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

  // Pulse animation for location loading state
  const pulseAnim = useRef(new Animated.Value(0.3)).current;
  // Toast fade animation
  const toastAnim = useRef(new Animated.Value(0)).current;
  const [showToast, setShowToast] = useState(true);

  // Pulse loop while locating
  useEffect(() => {
    if (!locating) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.8, duration: 800, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [locating, pulseAnim]);

  // Toast: fade in then fade out after 3s
  useEffect(() => {
    Animated.sequence([
      Animated.timing(toastAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
      Animated.delay(2200),
      Animated.timing(toastAnim, { toValue: 0, duration: 400, useNativeDriver: true }),
    ]).start(() => setShowToast(false));
  }, [toastAnim]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
      if (!mounted || status !== 'granted') {
        if (mounted) setLocating(false);
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
      setLocating(false);
    })();
    return () => { mounted = false; };
  }, []);

  const recenter = () => {
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

  const cardHeight = 220 + insets.bottom;

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_DEFAULT}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        showsUserLocation
      />

      {/* Dim overlay while no group is active */}
      <View style={styles.dimOverlay} pointerEvents="none" />

      {/* Loading pulse when waiting for GPS */}
      {locating && (
        <View style={styles.pulseWrapper} pointerEvents="none">
          <Animated.View style={[styles.pulseDot, { opacity: pulseAnim }]} />
        </View>
      )}

      {/* Welcome toast */}
      {showToast && (
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

      {/* Bottom CTA sheet */}
      <View style={[styles.bottomSheet, { height: cardHeight }]}>
        <View style={styles.sheetHandle} />
        <Text style={styles.sheetTitle}>🚗 Start or Join a Convoy</Text>

        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={() => router.push('/(tabs)/convoy')}
          accessibilityRole="button"
          accessibilityLabel="Create a new group"
        >
          <Text style={styles.primaryBtnText}>Create Group</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.outlineBtn}
          onPress={() => router.push('/(tabs)/convoy')}
          accessibilityRole="button"
          accessibilityLabel="Join a group with a code"
        >
          <Text style={styles.outlineBtnText}>Join with Code</Text>
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
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#1C1C1C',
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
    marginBottom: 16,
    textAlign: 'center',
  },
  primaryBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 14,
    paddingVertical: 16,
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
  outlineBtn: {
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#DC143C',
  },
  outlineBtnText: {
    color: '#DC143C',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
});
