import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Linking,
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
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useSettingsStore } from '../../stores/settingsStore';
import { useReduceMotion } from '../../hooks/useReduceMotion';
import { ThemeColors, useTheme, withAlpha } from '../../theme';

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

// Demo convoy markers on the preview map — kept as emoji (not vector icons) since
// they're map pins meant for quick, colorful at-a-glance recognition, same
// rationale as the hazard-type pins on the real MapScreen.
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

export default function GuestMapScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const overlayStyles = useMemo(() => makeOverlayStyles(colors), [colors]);
  const [initialRegion, setInitialRegion] = useState(DEFAULT_REGION);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [recentering, setRecentering] = useState(false);
  const mapRef = useRef<MapView>(null);
  const mapStyle = useSettingsStore((s) => s.mapStyle);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const cycleMapType = () => {
    const next = mapStyle === 'standard' ? 'satellite' : mapStyle === 'satellite' ? 'hybrid' : 'standard';
    setSettings({ mapStyle: next });
  };

  // Demo marker progress (0-1 per route), staggered starts
  const [markerProgress, setMarkerProgress] = useState<number[]>(
    DEMO_ROUTES.map((_, i) => i * 0.28),
  );

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const cardSlide = useRef(new Animated.Value(120)).current;
  const cardOpacity = useRef(new Animated.Value(0)).current;
  const pillScale = useRef(new Animated.Value(0.8)).current;

  // Pulse preview pill opacity
  const reduceMotion = useReduceMotion();
  useEffect(() => {
    if (reduceMotion) {
      // OS reduce-motion: hold the preview pill at full opacity — its label
      // already communicates preview mode without the attention pulse.
      pulseAnim.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.5, duration: 1100, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1100, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulseAnim, reduceMotion]);

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
      setRecentering(true);
      try {
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
      } catch {
        // Non-fatal — the preview simply stays on the default region.
      } finally {
        if (mounted) setRecentering(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Re-center the map on the user's current position, with a visible spinner
  // while the GPS fix resolves and a clear, actionable error if it can't.
  const handleRecenter = async () => {
    setRecentering(true);
    try {
      const loc = await ExpoLocation.getCurrentPositionAsync({
        accuracy: ExpoLocation.Accuracy.Balanced,
      });
      mapRef.current?.animateToRegion(
        {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
          latitudeDelta: 0.05,
          longitudeDelta: 0.05,
        },
        500,
      );
    } catch {
      Alert.alert(
        'Location unavailable',
        "We couldn't get your location. Check that location access is enabled for Cortege.",
      );
    } finally {
      setRecentering(false);
    }
  };

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_DEFAULT}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        mapType={mapStyle}
        showsUserLocation
      >
        {DEMO_ROUTES.map((route, i) => {
          const pos = interpolateRoute(route.coords, markerProgress[i]);
          return (
            <React.Fragment key={route.key}>
              <Polyline
                coordinates={route.coords}
                strokeColor={withAlpha(colors.accent, 0.33)}
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

      {/* Re-center button — theme-reactive floating control, matching
          IdleMapScreen's map utility buttons. Shows a spinner while the GPS
          fix is resolving so the async action always has visible feedback. */}
      <TouchableOpacity
        style={[styles.recenterBtn, { top: insets.top + 8 }]}
        onPress={handleRecenter}
        disabled={recentering}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel="Re-center map on your location"
        accessibilityState={{ disabled: recentering, busy: recentering }}
      >
        {recentering ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : (
          <Ionicons name="locate" size={22} color={colors.text} />
        )}
      </TouchableOpacity>

      {/* Map style cycle button */}
      <TouchableOpacity
        style={[styles.mapTypeBtn, { top: insets.top + 8 }]}
        onPress={cycleMapType}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={`Map style: ${mapStyle}. Tap to cycle.`}
      >
        <MaterialCommunityIcons
          name={mapStyle === 'standard' ? 'map-outline' : mapStyle === 'satellite' ? 'satellite-variant' : 'earth'}
          size={18}
          color={colors.text}
        />
      </TouchableOpacity>

      {/* Preview Mode pill */}
      <Animated.View
        style={[
          styles.previewPill,
          { top: insets.top + 8, opacity: pulseAnim, transform: [{ scale: pillScale }] },
        ]}
      >
        <View style={styles.previewDot} />
        <Ionicons name="eye" size={12} color="#CCCCCC" />
        <Text style={styles.previewPillText}>PREVIEW — Sign in to drive</Text>
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
          <Ionicons name="location" size={36} color={colors.accent} style={{ marginBottom: 12 }} />
          <Text style={styles.locationCardTitle}>Enable Location</Text>
          <Text style={styles.locationCardBody}>
            Allow location access so Cortege can center the map on you and share your position with your group.
          </Text>
          <TouchableOpacity
            style={styles.locationCardBtn}
            onPress={() => {
              Linking.openSettings().catch(() =>
                Alert.alert(
                  'Location Access',
                  'Open Settings → Privacy → Location Services → Cortege, then set to "While Using App".',
                ),
              );
            }}
            activeOpacity={0.85}
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
        <Text style={styles.logo}>CORTEGE</Text>
        <Text style={styles.tagline}>The app built for car enthusiasts.</Text>

        <View style={overlayStyles.checkList}>
          <Text style={overlayStyles.checkItem}>✓  Real-time convoy tracking</Text>
          <Text style={overlayStyles.checkItem}>✓  Push-to-talk radio</Text>
          <Text style={overlayStyles.checkItem}>✓  Live gap alerts</Text>
        </View>

        <TouchableOpacity
          style={styles.createBtn}
          onPress={() => router.push('/(auth)/welcome')}
          activeOpacity={0.85}
          accessibilityLabel="Create free Cortege account"
          accessibilityRole="button"
        >
          <Text style={styles.createBtnText}>Create Free Account</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.signInBtn}
          onPress={() => router.push('/(auth)/welcome')}
          activeOpacity={0.7}
          accessibilityLabel="Sign in to Cortege"
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

function makeStyles(colors: ThemeColors) {
return StyleSheet.create({
  container: { flex: 1 },

  markerBubble: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#1C1C1Cf2',
    borderWidth: 1.5,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.accent,
    shadowOpacity: 0.5,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  markerEmoji: { fontSize: 15 },

  // Theme-reactive floating map controls, matching IdleMapScreen's recenterBtn.
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
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
    zIndex: 10,
  },

  mapTypeBtn: {
    position: 'absolute',
    right: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
    zIndex: 10,
  },

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
    borderColor: withAlpha(colors.accent, 0.44),
    gap: 6,
    zIndex: 10,
  },
  previewDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: colors.accent,
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
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
  // locationCard's background is a fixed dark translucent card regardless of app
  // theme (it floats over the map, matching recenterBtn/mapTypeBtn above), so its
  // text stays fixed light/gray rather than following colors.text/textMuted.
  locationCardTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  locationCardBody: {
    color: '#888888',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
    marginBottom: 20,
  },
  locationCardBtn: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 32,
  },
  // locationCardBtn's background is the fixed-value accent color (same in both
  // themes), so its label stays fixed white for contrast rather than colors.text.
  locationCardBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },

  // This card's background is a fixed dark translucent surface regardless of app
  // theme (a branded pre-login marketing card floating over the map preview), so
  // its text below stays fixed light/gray rather than following colors.text/etc.
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
    borderColor: colors.border,
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

  createBtn: {
    width: '100%',
    backgroundColor: colors.accent,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    shadowColor: colors.accent,
    shadowOpacity: 0.45,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  // createBtn's background is the fixed-value accent color (same in both themes),
  // so its label stays fixed white rather than colors.text.
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
}

function makeOverlayStyles(colors: ThemeColors) {
return StyleSheet.create({
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

  // Theme-reactive chip floating over the map (matches IdleMapScreen's
  // nearbyPill): background/border/text all follow the active palette so the
  // border stays visible in Light mode instead of a near-invisible white hairline.
  annotationBubble: {
    position: 'absolute',
    backgroundColor: colors.card,
    borderRadius: 10,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
    zIndex: 5,
  },
  annotationText: {
    color: colors.text,
    fontSize: 11,
    fontWeight: '600',
  },
});
}
