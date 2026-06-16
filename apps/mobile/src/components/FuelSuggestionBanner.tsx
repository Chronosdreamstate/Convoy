/**
 * FuelSuggestionBanner — shown to Admin when distance/time threshold is reached.
 * Requirements: 21.1–21.5
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
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

export default function FuelSuggestionBanner({
  groupId, myLat, myLng, isAdmin, onSelectStation, onDismiss,
}: Props) {
  const [stations, setStations] = useState<FuelStation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [noResults, setNoResults] = useState(false);

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
      }
    } catch {
      Alert.alert('Error', 'Could not fetch fuel stations.');
    } finally {
      setLoading(false);
    }
  }, [myLat, myLng]);

  if (stations !== null) {
    return (
      <View style={styles.panel}>
        <View style={styles.header}>
          <Text style={styles.title}>Fuel Stations Nearby</Text>
          <TouchableOpacity onPress={() => setStations(null)}>
            <Text style={styles.close}>Done</Text>
          </TouchableOpacity>
        </View>
        {noResults ? (
          <Text style={styles.noResults}>No fuel stations found nearby</Text>
        ) : (
          <FlatList
            data={stations}
            keyExtractor={(s) => s.id}
            style={styles.list}
            renderItem={({ item: s }) => (
              <TouchableOpacity
                style={styles.stationRow}
                onPress={() => { onSelectStation(s); setStations(null); }}
              >
                <View style={styles.stationInfo}>
                  <Text style={styles.stationName}>{s.name}</Text>
                  <Text style={styles.stationAddr} numberOfLines={1}>{s.address}</Text>
                </View>
                <Text style={styles.stationDist}>
                  {s.distanceM >= 1000
                    ? `${(s.distanceM / 1000).toFixed(1)} km`
                    : `${s.distanceM} m`}
                </Text>
              </TouchableOpacity>
            )}
          />
        )}
      </View>
    );
  }

  return (
    <View style={styles.banner}>
      <Text style={styles.bannerText}>
        {isAdmin
          ? '⛽ Time for a fuel stop? The group has been driving a while.'
          : '⛽ Find fuel nearby'}
      </Text>
      <View style={styles.bannerActions}>
        <TouchableOpacity
          style={styles.findBtn}
          onPress={fetchStations}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={styles.findBtnText}>Find Fuel</Text>
          }
        </TouchableOpacity>
        <TouchableOpacity style={styles.dismissBtn} onPress={onDismiss}>
          <Text style={styles.dismissText}>Dismiss</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: '#1e3a5f', borderRadius: 10, padding: 12, margin: 8,
    borderWidth: 1, borderColor: '#3b82f6',
  },
  bannerText: { color: '#93c5fd', fontSize: 13, marginBottom: 8 },
  bannerActions: { flexDirection: 'row', gap: 8 },
  findBtn: {
    flex: 1, backgroundColor: '#3b82f6', borderRadius: 8,
    paddingVertical: 8, alignItems: 'center', minHeight: 44,
    justifyContent: 'center',
  },
  findBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  dismissBtn: {
    paddingHorizontal: 12, paddingVertical: 8, minHeight: 44,
    justifyContent: 'center',
  },
  dismissText: { color: '#64748b', fontSize: 13 },

  panel: {
    backgroundColor: '#0f172a', borderRadius: 12,
    borderWidth: 1, borderColor: '#334155',
    maxHeight: 300, margin: 8,
  },
  header: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', padding: 12,
    borderBottomWidth: 1, borderBottomColor: '#334155',
  },
  title: { color: '#f1f5f9', fontWeight: '700', fontSize: 15 },
  close: { color: '#3b82f6', fontSize: 14 },
  list: { maxHeight: 240 },
  stationRow: {
    flexDirection: 'row', alignItems: 'center',
    padding: 12, borderBottomWidth: 1, borderBottomColor: '#1e293b',
    minHeight: 56,
  },
  stationInfo: { flex: 1 },
  stationName: { color: '#e2e8f0', fontSize: 14, fontWeight: '600' },
  stationAddr: { color: '#64748b', fontSize: 12, marginTop: 2 },
  stationDist: { color: '#3b82f6', fontSize: 13, marginLeft: 8 },
  noResults: { color: '#64748b', textAlign: 'center', padding: 20, fontSize: 13 },
});
