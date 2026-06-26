/**
 * FuelSuggestionBanner — shown to Admin when distance/time threshold is reached.
 * Requirements: 21.1–21.5
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { apiClient } from '../services/apiClient';

interface FuelStation {
  id: string;
  name: string;
  distanceM: number;
  lat: number;
  lng: number;
  address: string;
}

interface Props {
  groupId: string;
  myLat: number;
  myLng: number;
  isAdmin: boolean;
  /** Called when admin selects a station to broadcast as a waypoint. */
  onSelectStation: (station: FuelStation) => void;
  onDismiss: () => void;
}

function formatDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
}

export default function FuelSuggestionBanner({
  myLat, myLng, isAdmin, onSelectStation, onDismiss,
}: Props) {
  const [stations, setStations] = useState<FuelStation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [noResults, setNoResults] = useState(false);
  const [stationIndex, setStationIndex] = useState(0);

  const slideAnim = useRef(new Animated.Value(-100)).current;

  // Slide in on mount
  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: 0,
      useNativeDriver: true,
      damping: 20,
      stiffness: 200,
      mass: 0.8,
    }).start();
  }, [slideAnim]);

  // Animate out before calling parent dismiss
  const handleDismiss = useCallback(() => {
    Animated.timing(slideAnim, {
      toValue: -100,
      duration: 200,
      useNativeDriver: true,
    }).start(() => onDismiss());
  }, [slideAnim, onDismiss]);

  const fetchStations = useCallback(async () => {
    setLoading(true);
    setNoResults(false);
    try {
      const res = await apiClient.get<{ stations: FuelStation[]; message?: string }>(
        `/api/v1/places/fuel?lat=${myLat}&lng=${myLng}`,
      );
      if (res.data.stations.length === 0) {
        setNoResults(true);
        setStations([]);
      } else {
        setStations(res.data.stations);
        setStationIndex(0);
      }
    } catch {
      Alert.alert('Error', 'Could not fetch fuel stations.');
    } finally {
      setLoading(false);
    }
  }, [myLat, myLng]);

  const total = stations?.length ?? 0;
  const current = total > 0 ? stations![stationIndex] : null;

  const titleText = loading
    ? 'Searching...'
    : stations === null
      ? 'Fuel stop ahead?'
      : noResults
        ? 'No stations found'
        : (current?.name ?? 'Fuel Stop');

  return (
    <Animated.View style={[styles.wrapper, { transform: [{ translateY: slideAnim }] }]}>
      {/* Left amber accent strip */}
      <View style={styles.leftStrip} />

      <View style={styles.body}>
        {/* Header row: counter | emoji + title | close */}
        <View style={styles.headerRow}>
          {total > 1 && (
            <Text style={styles.counter}>{stationIndex + 1}/{total}</Text>
          )}
          <View style={styles.titleRow}>
            <Text style={styles.emoji}>⛽</Text>
            <Text style={styles.title} numberOfLines={1}>{titleText}</Text>
          </View>
          <TouchableOpacity
            onPress={handleDismiss}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="Dismiss fuel suggestion"
          >
            <Text style={styles.closeBtn}>✕</Text>
          </TouchableOpacity>
        </View>

        {/* Subtitle */}
        {stations === null && !loading && (
          <Text style={styles.subtitle}>
            {isAdmin
              ? 'The group has been driving a while. Find a nearby station.'
              : 'Find nearby fuel stations.'}
          </Text>
        )}
        {current && (
          <Text style={styles.subtitle} numberOfLines={1}>
            {current.address} · {formatDist(current.distanceM)}
          </Text>
        )}
        {noResults && (
          <Text style={styles.subtitle}>No fuel stations found in your area.</Text>
        )}

        {/* Multi-station cycling controls */}
        {total > 1 && (
          <View style={styles.cycleRow}>
            <TouchableOpacity
              style={styles.arrowBtn}
              onPress={() => setStationIndex((i) => Math.max(0, i - 1))}
              disabled={stationIndex === 0}
              accessibilityRole="button"
              accessibilityLabel="Previous station"
            >
              <Text style={[styles.arrowText, stationIndex === 0 && styles.arrowDisabled]}>←</Text>
            </TouchableOpacity>
            {isAdmin && current && (
              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={() => { onSelectStation(current); handleDismiss(); }}
                accessibilityRole="button"
                accessibilityLabel={`Add ${current.name} as waypoint`}
              >
                <Text style={styles.primaryBtnText}>Add waypoint</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.arrowBtn}
              onPress={() => setStationIndex((i) => Math.min(total - 1, i + 1))}
              disabled={stationIndex === total - 1}
              accessibilityRole="button"
              accessibilityLabel="Next station"
            >
              <Text style={[styles.arrowText, stationIndex === total - 1 && styles.arrowDisabled]}>→</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Pre-fetch or single-result action row */}
        {(stations === null || (total === 1 && current)) && !noResults && (
          <View style={styles.actionRow}>
            {stations === null ? (
              <>
                <TouchableOpacity
                  style={styles.primaryBtn}
                  onPress={fetchStations}
                  disabled={loading}
                  accessibilityRole="button"
                  accessibilityLabel="Find nearby fuel stations"
                  accessibilityState={{ disabled: loading }}
                >
                  {loading
                    ? <ActivityIndicator color="#fff" size="small" />
                    : <Text style={styles.primaryBtnText}>Find Fuel</Text>
                  }
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.ghostBtn}
                  onPress={handleDismiss}
                  accessibilityRole="button"
                  accessibilityLabel="Dismiss fuel suggestion"
                >
                  <Text style={styles.ghostBtnText}>Not now</Text>
                </TouchableOpacity>
              </>
            ) : (
              isAdmin && current && (
                <TouchableOpacity
                  style={styles.primaryBtn}
                  onPress={() => { onSelectStation(current); handleDismiss(); }}
                  accessibilityRole="button"
                  accessibilityLabel={`Add ${current.name} as waypoint`}
                >
                  <Text style={styles.primaryBtnText}>Add waypoint</Text>
                </TouchableOpacity>
              )
            )}
          </View>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flexDirection: 'row',
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
  leftStrip: {
    width: 4,
    backgroundColor: '#F59E0B',
  },
  body: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  counter: {
    color: '#F59E0B',
    fontSize: 11,
    fontWeight: '700',
    marginRight: 8,
    minWidth: 28,
  },
  titleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  emoji: {
    fontSize: 18,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
    flexShrink: 1,
  },
  closeBtn: {
    color: '#555555',
    fontSize: 16,
    fontWeight: '600',
    paddingLeft: 10,
  },
  subtitle: {
    color: '#888888',
    fontSize: 13,
    marginTop: 2,
    marginBottom: 10,
  },
  cycleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  arrowBtn: {
    minWidth: 36,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowText: {
    color: '#F59E0B',
    fontSize: 20,
    fontWeight: '700',
  },
  arrowDisabled: {
    color: '#333333',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  primaryBtn: {
    flex: 1,
    backgroundColor: '#DC143C',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 13,
  },
  ghostBtn: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    justifyContent: 'center',
  },
  ghostBtnText: {
    color: '#888888',
    fontSize: 13,
  },
});
