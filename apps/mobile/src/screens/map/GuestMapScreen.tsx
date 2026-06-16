/**
 * Guest MapScreen (Req 1.1–1.6, 36.4)
 * Shown to unauthenticated users and users not in a convoy.
 * Displays current device location; disables convoy-only features.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  useColorScheme,
} from 'react-native';
import MapboxGL from '@rnmapbox/maps';
import * as ExpoLocation from 'expo-location';
import { useAuthStore } from '../../stores/authStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MapStyle = 'standard' | 'satellite' | 'hybrid';

const MAP_STYLE_URLS: Record<MapStyle, string> = {
  standard: MapboxGL.StyleURL.Street,
  satellite: MapboxGL.StyleURL.Satellite,
  hybrid: MapboxGL.StyleURL.SatelliteStreet,
};

interface Props {
  mapboxAccessToken: string;
  onSignIn?: () => void;
  onJoinConvoy?: () => void;
  onCreateConvoy?: () => void;
}

// ---------------------------------------------------------------------------
// GuestMapScreen
// ---------------------------------------------------------------------------

export default function GuestMapScreen({
  mapboxAccessToken,
  onSignIn,
  onJoinConvoy,
  onCreateConvoy,
}: Props) {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const { isAuthenticated } = useAuthStore();

  const [mapStyle, setMapStyle] = useState<MapStyle>('standard');
  const [permissionGranted, setPermissionGranted] = useState(false);

  const cameraRef = useRef<MapboxGL.Camera>(null);

  MapboxGL.setAccessToken(mapboxAccessToken);

  // Request "While Using" location permission on first launch (Req 36.4)
  useEffect(() => {
    (async () => {
      const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
      setPermissionGranted(status === 'granted');
    })();
  }, []);

  const recenter = useCallback(() => {
    cameraRef.current?.setCamera({ zoomLevel: 14, animationDuration: 500 });
  }, []);

  const bg = isDark ? '#0f172a' : '#f8fafc';
  const text = isDark ? '#f1f5f9' : '#0f172a';
  const subtleText = isDark ? '#94a3b8' : '#64748b';
  const cardBg = isDark ? '#1e293b' : '#ffffff';
  const borderColor = isDark ? '#334155' : '#e2e8f0';

  return (
    <View style={[styles.container, { backgroundColor: bg }]}>
      {/* Map (Req 1.1) */}
      <MapboxGL.MapView
        style={styles.map}
        styleURL={MAP_STYLE_URLS[mapStyle]}
        logoEnabled={false}
        // Pinch-to-zoom, double-tap zoom, free pan all enabled by default (Req 1.2–1.4)
      >
        <MapboxGL.Camera
          ref={cameraRef}
          followUserLocation={permissionGranted}
          followUserMode="course"
          zoomLevel={13}
          animationMode="flyTo"
        />
        {permissionGranted && (
          <MapboxGL.UserLocation visible animated showsUserHeadingIndicator />
        )}
      </MapboxGL.MapView>

      {/* Re-center button (Req 1.6) */}
      <TouchableOpacity
        style={[styles.recenterBtn, { backgroundColor: cardBg, borderColor }]}
        onPress={recenter}
        accessibilityLabel="Re-centre map"
      >
        <Text style={{ fontSize: 22, color: text }}>◎</Text>
      </TouchableOpacity>

      {/* Map style switcher (Req 1.5) */}
      <View style={[styles.styleSwitch, { backgroundColor: cardBg, borderColor }]}>
        {(['standard', 'satellite', 'hybrid'] as MapStyle[]).map((s) => (
          <TouchableOpacity
            key={s}
            onPress={() => setMapStyle(s)}
            style={[styles.styleBtn, mapStyle === s && styles.styleBtnActive]}
          >
            <Text style={[styles.styleBtnText, { color: mapStyle === s ? '#fff' : subtleText }]}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Convoy action panel — disabled for guests (Req 1.1) */}
      <View style={[styles.actionPanel, { backgroundColor: cardBg, borderColor }]}>
        {isAuthenticated ? (
          <>
            <TouchableOpacity style={styles.primaryBtn} onPress={onCreateConvoy}>
              <Text style={styles.primaryBtnText}>Create Convoy</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.secondaryBtn, { borderColor }]} onPress={onJoinConvoy}>
              <Text style={[styles.secondaryBtnText, { color: text }]}>Join Convoy</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={[styles.guestNote, { color: subtleText }]}>
              Sign in to create or join a convoy
            </Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={onSignIn}>
              <Text style={styles.primaryBtnText}>Sign In</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },

  recenterBtn: {
    position: 'absolute', top: 52, left: 12,
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
    shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 4, elevation: 3,
  },

  styleSwitch: {
    position: 'absolute', top: 52, right: 12,
    flexDirection: 'row', borderRadius: 8, borderWidth: 1, overflow: 'hidden',
  },
  styleBtn: { paddingHorizontal: 10, paddingVertical: 8 },
  styleBtnActive: { backgroundColor: '#3b82f6' },
  styleBtnText: { fontSize: 12, fontWeight: '600' },

  actionPanel: {
    padding: 16, borderTopWidth: 1,
    gap: 10,
  },
  primaryBtn: {
    backgroundColor: '#3b82f6', borderRadius: 10, padding: 14,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  secondaryBtn: {
    borderWidth: 1, borderRadius: 10, padding: 14,
    alignItems: 'center',
  },
  secondaryBtnText: { fontWeight: '600', fontSize: 15 },
  guestNote: { textAlign: 'center', fontSize: 13, marginBottom: 4 },
});
