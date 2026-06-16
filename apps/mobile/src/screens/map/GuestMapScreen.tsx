import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
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

export default function GuestMapScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [initialRegion, setInitialRegion] = useState(DEFAULT_REGION);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const mapRef = React.useRef<MapView>(null);

  useEffect(() => {
    (async () => {
      const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setPermissionDenied(true);
        return;
      }
      const loc = await ExpoLocation.getCurrentPositionAsync({});
      const region = {
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        latitudeDelta: 0.05,
        longitudeDelta: 0.05,
      };
      setInitialRegion(region);
      mapRef.current?.animateToRegion(region, 500);
    })();
  }, []);

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_DEFAULT}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        showsUserLocation
      />

      {permissionDenied && (
        <View style={styles.permissionBanner}>
          <Text style={styles.permissionText}>
            Location access denied — enable it in Settings to center the map on you.
          </Text>
        </View>
      )}

      {/* Bottom card */}
      <View style={[styles.card, { bottom: Math.max(insets.bottom, 16) + 16 }]}>
        {/* Convoy logo / wordmark */}
        <Text style={styles.logo}>CONVOY</Text>
        <View style={styles.divider} />

        <Text style={styles.tagline}>Sign in to join a convoy</Text>
        <Text style={styles.sub}>
          Share your real-time location with your group, set rally points, and stay together on the road.
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

  permissionBanner: {
    position: 'absolute',
    top: 16,
    left: 16,
    right: 16,
    backgroundColor: '#1C1C1Ef0',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#DC143C40',
  },
  permissionText: {
    color: '#F0F0F0',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },

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
