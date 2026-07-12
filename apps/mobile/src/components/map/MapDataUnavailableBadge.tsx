/**
 * MapDataUnavailableBadge — unobtrusive pill shown while the device is offline
 * and the viewed map area falls outside the cached offline tile corridor
 * (Req 4.4: "IF the required tiles are not cached, THEN THE Map_View SHALL
 * display a visual indicator that map data is unavailable for that area").
 *
 * Presentational only: MapScreen decides visibility (connectivity × viewed
 * region × cached bounds) and mounts/unmounts this badge; the coverage
 * predicate lives here as a pure helper so both sides stay testable.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useReduceMotion } from '../../hooks/useReduceMotion';

/** The slice of a react-native-maps Region this component's helper reads. */
export interface ViewedRegion {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}

/** [[minLng, minLat], [maxLng, maxLat]] — computeBoundsWithBuffer's shape. */
export type CachedTileBounds = [[number, number], [number, number]];

/**
 * True when the ENTIRE viewed region sits inside the cached tile bounds — a
 * viewport that even partially leaves the cached corridor is showing an area
 * whose map data is unavailable offline (Req 4.4). No region yet (map still
 * initialising) or no bounds (nothing prefetched — no active route) both mean
 * "not covered". Pure function — exported for tests.
 */
export function regionHasCachedMapData(
  region: ViewedRegion | null,
  bounds: CachedTileBounds | null,
): boolean {
  if (!region || !bounds) return false;
  const [[minLng, minLat], [maxLng, maxLat]] = bounds;
  const west = region.longitude - region.longitudeDelta / 2;
  const east = region.longitude + region.longitudeDelta / 2;
  const south = region.latitude - region.latitudeDelta / 2;
  const north = region.latitude + region.latitudeDelta / 2;
  return west >= minLng && east <= maxLng && south >= minLat && north <= maxLat;
}

function MapDataUnavailableBadge() {
  const reduceMotion = useReduceMotion();
  const opacity = useRef(new Animated.Value(0)).current;

  // Gentle fade-in on mount; with reduce-motion enabled the badge appears
  // instantly instead (Req 39 — no decorative motion for those users).
  useEffect(() => {
    if (reduceMotion) {
      opacity.setValue(1);
      return;
    }
    Animated.timing(opacity, { toValue: 1, duration: 250, useNativeDriver: true }).start();
  }, [reduceMotion, opacity]);

  return (
    <Animated.View
      testID="map-data-unavailable-badge"
      style={[styles.badge, { opacity }]}
      accessibilityLiveRegion="polite"
      accessibilityLabel="Map data unavailable for this area"
    >
      <MaterialCommunityIcons name="map-marker-off" size={14} color="#FBBF24" />
      <Text style={styles.text} numberOfLines={1}>
        Map data unavailable
      </Text>
    </Animated.View>
  );
}

// React.memo — mounted inside MapScreen, which re-renders on every GPS tick;
// this badge takes no props, so it never needs to re-render at all.
const MemoMapDataUnavailableBadge = React.memo(MapDataUnavailableBadge);
MemoMapDataUnavailableBadge.displayName = 'MapDataUnavailableBadge';
export default MemoMapDataUnavailableBadge;

const styles = StyleSheet.create({
  // Fixed dark translucent chip regardless of theme (it floats directly over
  // map imagery, same rationale as MapScreen's mapTypeBtn), so the amber icon
  // and white label stay fixed too.
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(28,28,28,0.92)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  text: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
  },
});
