/**
 * FuelStopSheet — modal bottom sheet showing nearby fuel stations fetched
 * from OpenStreetMap via FuelStopService (Overpass API, no key required).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  FlatList,
  Linking,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { FuelStopService, type FuelStation } from '../services/FuelStopService';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  visible: boolean;
  onClose: () => void;
  userLat: number;
  userLon: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
}

function openMapsDirections(lat: number, lon: number, name: string): void {
  const encodedName = encodeURIComponent(name);
  const appleUrl = `maps://maps.apple.com/?daddr=${lat},${lon}&q=${encodedName}`;
  const googleUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&destination_place_id=${encodedName}`;

  if (Platform.OS === 'ios') {
    Linking.canOpenURL(appleUrl)
      .then((supported) =>
        Linking.openURL(supported ? appleUrl : googleUrl),
      )
      .catch(() => Linking.openURL(googleUrl));
  } else {
    Linking.openURL(googleUrl).catch(() => {/* no-op */});
  }
}

// ---------------------------------------------------------------------------
// Skeleton rows (3 placeholder rows while loading)
// ---------------------------------------------------------------------------

function SkeletonFuelRow() {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);

  return (
    <Animated.View style={[styles.skeletonRow, { opacity }]}>
      <View style={styles.skeletonIcon} />
      <View style={styles.skeletonLines}>
        <View style={[styles.skeletonBox, { width: '55%', marginBottom: 6 }]} />
        <View style={[styles.skeletonBox, { width: '30%', height: 11 }]} />
      </View>
      <View style={[styles.skeletonBox, { width: 50, height: 22, borderRadius: 11 }]} />
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Station row
// ---------------------------------------------------------------------------

interface StationRowProps {
  station: FuelStation;
}

function StationRow({ station }: StationRowProps) {
  const handlePress = useCallback(() => {
    openMapsDirections(station.lat, station.lon, station.name);
  }, [station]);

  return (
    <TouchableOpacity
      style={styles.stationRow}
      onPress={handlePress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`Open directions to ${station.name}, ${formatDist(station.distanceM)} away`}
    >
      <Text style={styles.stationIcon}>⛽</Text>
      <View style={styles.stationInfo}>
        <Text style={styles.stationName} numberOfLines={1}>{station.name}</Text>
        <Text style={styles.stationSub}>Open in Maps</Text>
      </View>
      <View style={styles.distanceBadge}>
        <Text style={styles.distanceText}>{formatDist(station.distanceM)}</Text>
      </View>
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// Main sheet
// ---------------------------------------------------------------------------

const SCREEN_HEIGHT = Dimensions.get('window').height;
const SHEET_HEIGHT = SCREEN_HEIGHT * 0.45;

export default function FuelStopSheet({ visible, onClose, userLat, userLon }: Props) {
  const slideAnim = useRef(new Animated.Value(SHEET_HEIGHT)).current;

  const [stations, setStations] = useState<FuelStation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  // Slide the sheet in when it becomes visible
  useEffect(() => {
    if (visible) {
      // Reset state for fresh load
      setStations(null);
      setError(false);
      setLoading(true);

      // Animate in
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        damping: 22,
        stiffness: 220,
        mass: 0.9,
      }).start();

      // Fetch stations
      FuelStopService.fetchNearbyFuel(userLat, userLon)
        .then((data) => {
          setStations(data);
        })
        .catch(() => {
          setError(true);
          setStations([]);
        })
        .finally(() => setLoading(false));
    } else {
      // Slide out
      Animated.timing(slideAnim, {
        toValue: SHEET_HEIGHT,
        duration: 220,
        useNativeDriver: true,
      }).start();
    }
  }, [visible, userLat, userLon, slideAnim]);

  const handleClose = useCallback(() => {
    Animated.timing(slideAnim, {
      toValue: SHEET_HEIGHT,
      duration: 220,
      useNativeDriver: true,
    }).start(() => onClose());
  }, [slideAnim, onClose]);

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  function renderContent() {
    if (loading) {
      return (
        <View>
          <SkeletonFuelRow />
          <SkeletonFuelRow />
          <SkeletonFuelRow />
        </View>
      );
    }

    if (error) {
      return (
        <View style={styles.centerState}>
          <Text style={styles.stateText}>Couldn't load fuel stops — check connection</Text>
        </View>
      );
    }

    if (!stations || stations.length === 0) {
      return (
        <View style={styles.centerState}>
          <Text style={styles.stateText}>No fuel stops found within 5km</Text>
        </View>
      );
    }

    return (
      <FlatList
        data={stations}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <StationRow station={item} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
      />
    );
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={handleClose}
      statusBarTranslucent
    >
      {/* Backdrop */}
      <TouchableOpacity
        style={styles.backdrop}
        activeOpacity={1}
        onPress={handleClose}
        accessibilityRole="button"
        accessibilityLabel="Close fuel stop sheet"
      />

      {/* Sheet */}
      <Animated.View
        style={[styles.sheet, { transform: [{ translateY: slideAnim }] }]}
      >
        {/* Drag handle */}
        <View style={styles.handleContainer}>
          <View style={styles.handle} />
        </View>

        {/* Title */}
        <Text style={styles.title}>⛽ Nearby Fuel</Text>

        {/* Content */}
        {renderContent()}
      </Animated.View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: SHEET_HEIGHT,
    backgroundColor: '#1C1C1C',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  handleContainer: {
    alignItems: 'center',
    paddingTop: 12,
    paddingBottom: 8,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#2A2A2A',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 14,
  },
  listContent: {
    paddingBottom: 8,
  },
  separator: {
    height: 1,
    backgroundColor: '#2A2A2A',
    marginHorizontal: 4,
  },
  // Station row
  stationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 12,
  },
  stationIcon: {
    fontSize: 22,
  },
  stationInfo: {
    flex: 1,
  },
  stationName: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 2,
  },
  stationSub: {
    color: '#888888',
    fontSize: 12,
  },
  distanceBadge: {
    backgroundColor: '#242424',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  distanceText: {
    color: '#DC143C',
    fontSize: 12,
    fontWeight: '700',
  },
  // Empty / error states
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 32,
  },
  stateText: {
    color: '#888888',
    fontSize: 14,
    textAlign: 'center',
  },
  // Skeleton
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 12,
  },
  skeletonIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#2A2A2A',
  },
  skeletonLines: {
    flex: 1,
  },
  skeletonBox: {
    height: 14,
    borderRadius: 4,
    backgroundColor: '#2A2A2A',
  },
});
