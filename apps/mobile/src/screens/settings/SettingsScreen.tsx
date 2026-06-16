import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  ActivityIndicator,
  Switch,
  Alert,
} from 'react-native';
import { apiClient } from '../../services/apiClient';

interface Settings {
  hazardAlertDistanceM: number;
  pttMaxSeconds: number;
  tileCacheLimitMb: number;
  scenicRouting: boolean;
  mapStyle: 'standard' | 'satellite' | 'hybrid';
  notifHazard: boolean;
  notifGroupEvents: boolean;
  notifFriendRequests: boolean;
  notifNavigation: boolean;
}

const MILES_PER_METRE = 0.000621371;
const MAP_STYLES: Array<{ label: string; value: Settings['mapStyle'] }> = [
  { label: 'Standard', value: 'standard' },
  { label: 'Satellite', value: 'satellite' },
  { label: 'Hybrid', value: 'hybrid' },
];
const HAZARD_DISTANCES = [
  { label: '0.25 mi', metres: 402 },
  { label: '0.5 mi', metres: 805 },
  { label: '1 mi', metres: 1609 },
  { label: '2 mi', metres: 3219 },
];
const CACHE_SIZES = [
  { label: '100 MB', mb: 100 },
  { label: '250 MB', mb: 250 },
  { label: '500 MB', mb: 500 },
];
const PTT_DURATIONS = [
  { label: '15 s', seconds: 15 },
  { label: '30 s', seconds: 30 },
  { label: '60 s', seconds: 60 },
];

export default function SettingsScreen() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  // Local editable copies
  const [mapStyle, setMapStyle] = useState<Settings['mapStyle']>('standard');
  const [hazardDistM, setHazardDistM] = useState(805);
  const [cacheMb, setCacheMb] = useState(500);
  const [pttMaxSecs, setPttMaxSecs] = useState(30);
  const [scenicRouting, setScenicRouting] = useState(false);
  const [notifHazard, setNotifHazard] = useState(true);
  const [notifGroupEvents, setNotifGroupEvents] = useState(true);
  const [notifFriendRequests, setNotifFriendRequests] = useState(true);
  const [notifNavigation, setNotifNavigation] = useState(true);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await apiClient.get<Settings>('/api/v1/settings');
      const s = response.data;
      applySettings(s);
      setSettings(s);
      setIsDirty(false);
    } catch {
      setError('Failed to load settings. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const applySettings = (s: Settings) => {
    setMapStyle(s.mapStyle);
    setHazardDistM(s.hazardAlertDistanceM);
    setCacheMb(s.tileCacheLimitMb);
    setPttMaxSecs(s.pttMaxSeconds);
    setScenicRouting(s.scenicRouting);
    setNotifHazard(s.notifHazard);
    setNotifGroupEvents(s.notifGroupEvents);
    setNotifFriendRequests(s.notifFriendRequests);
    setNotifNavigation(s.notifNavigation);
  };

  const handleSave = async () => {
    if (!isDirty) return;

    setIsSaving(true);
    setError(null);
    try {
      const response = await apiClient.patch<Settings>('/api/v1/settings', {
        mapStyle,
        hazardAlertDistanceM: hazardDistM,
        tileCacheLimitMb: cacheMb,
        pttMaxSeconds: pttMaxSecs,
        scenicRouting,
        notifHazard,
        notifGroupEvents,
        notifFriendRequests,
        notifNavigation,
      });
      setSettings(response.data);
      setIsDirty(false);
      Alert.alert('Saved', 'Your settings have been updated.');
    } catch {
      setError('Failed to save settings. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const mark = () => setIsDirty(true);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <ActivityIndicator color="#FF6B00" size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>Settings</Text>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {/* Map */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Map</Text>

          <Text style={styles.label}>Map Style</Text>
          <View style={styles.chipRow}>
            {MAP_STYLES.map((opt) => (
              <TouchableOpacity
                key={opt.value}
                style={[styles.chip, mapStyle === opt.value && styles.chipActive]}
                onPress={() => { setMapStyle(opt.value); mark(); }}
                accessibilityRole="button"
                accessibilityLabel={`Map style ${opt.label}`}
              >
                <Text style={[styles.chipText, mapStyle === opt.value && styles.chipTextActive]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Navigation */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Navigation</Text>

          <View style={styles.switchRow}>
            <View style={styles.switchLabel}>
              <Text style={styles.switchTitle}>Scenic Routing</Text>
              <Text style={styles.switchSubtitle}>Prefer roads that avoid highways</Text>
            </View>
            <Switch
              value={scenicRouting}
              onValueChange={(v) => { setScenicRouting(v); mark(); }}
              trackColor={{ false: '#333', true: '#FF6B00' }}
              thumbColor="#FFFFFF"
              accessibilityLabel="Scenic routing toggle"
            />
          </View>
        </View>

        {/* Audio */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Audio</Text>

          <Text style={styles.label}>PTT Max Duration</Text>
          <View style={styles.chipRow}>
            {PTT_DURATIONS.map((opt) => (
              <TouchableOpacity
                key={opt.seconds}
                style={[styles.chip, pttMaxSecs === opt.seconds && styles.chipActive]}
                onPress={() => { setPttMaxSecs(opt.seconds); mark(); }}
                accessibilityRole="button"
                accessibilityLabel={`PTT max ${opt.label}`}
              >
                <Text style={[styles.chipText, pttMaxSecs === opt.seconds && styles.chipTextActive]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Offline */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Offline</Text>

          <Text style={styles.label}>Map Cache Size</Text>
          <View style={styles.chipRow}>
            {CACHE_SIZES.map((opt) => (
              <TouchableOpacity
                key={opt.mb}
                style={[styles.chip, cacheMb === opt.mb && styles.chipActive]}
                onPress={() => { setCacheMb(opt.mb); mark(); }}
                accessibilityRole="button"
                accessibilityLabel={`Cache size ${opt.label}`}
              >
                <Text style={[styles.chipText, cacheMb === opt.mb && styles.chipTextActive]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Notifications */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Notifications</Text>

          {[
            { label: 'Hazard Alerts', sub: 'Nearby road hazard notifications', value: notifHazard, onChange: (v: boolean) => { setNotifHazard(v); mark(); } },
            { label: 'Group Events', sub: 'Route pushes, mutes, session changes', value: notifGroupEvents, onChange: (v: boolean) => { setNotifGroupEvents(v); mark(); } },
            { label: 'Friend Requests', sub: 'Incoming friend requests', value: notifFriendRequests, onChange: (v: boolean) => { setNotifFriendRequests(v); mark(); } },
            { label: 'Navigation', sub: 'Arriving at destination alerts', value: notifNavigation, onChange: (v: boolean) => { setNotifNavigation(v); mark(); } },
          ].map((item) => (
            <View key={item.label} style={styles.switchRow}>
              <View style={styles.switchLabel}>
                <Text style={styles.switchTitle}>{item.label}</Text>
                <Text style={styles.switchSubtitle}>{item.sub}</Text>
              </View>
              <Switch
                value={item.value}
                onValueChange={item.onChange}
                trackColor={{ false: '#333', true: '#FF6B00' }}
                thumbColor="#FFFFFF"
                accessibilityLabel={`${item.label} notifications toggle`}
              />
            </View>
          ))}
        </View>

        {/* Hazard Alert Distance */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Safety</Text>

          <Text style={styles.label}>Hazard Alert Distance</Text>
          <Text style={styles.sublabel}>
            Alert me when a hazard is within{' '}
            {(hazardDistM * MILES_PER_METRE).toFixed(2)} miles
          </Text>
          <View style={styles.chipRow}>
            {HAZARD_DISTANCES.map((opt) => (
              <TouchableOpacity
                key={opt.metres}
                style={[styles.chip, hazardDistM === opt.metres && styles.chipActive]}
                onPress={() => { setHazardDistM(opt.metres); mark(); }}
                accessibilityRole="button"
                accessibilityLabel={`Hazard alert distance ${opt.label}`}
              >
                <Text style={[styles.chipText, hazardDistM === opt.metres && styles.chipTextActive]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <TouchableOpacity
          style={[styles.saveButton, (!isDirty || isSaving) && styles.saveButtonDisabled]}
          onPress={handleSave}
          disabled={!isDirty || isSaving}
          accessibilityRole="button"
          accessibilityLabel="Save settings"
        >
          {isSaving ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.saveButtonText}>Save Settings</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scroll: {
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 48,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#FFFFFF',
    marginBottom: 24,
  },
  section: {
    marginBottom: 32,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    marginBottom: 12,
  },
  label: {
    fontSize: 13,
    color: '#AAAAAA',
    marginBottom: 8,
  },
  sublabel: {
    fontSize: 12,
    color: '#666',
    marginBottom: 8,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: '#1A1A1A',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    minWidth: 44,
    alignItems: 'center',
  },
  chipActive: {
    backgroundColor: '#FF6B00',
    borderColor: '#FF6B00',
  },
  chipText: {
    color: '#AAAAAA',
    fontSize: 14,
    fontWeight: '500',
  },
  chipTextActive: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  switchLabel: {
    flex: 1,
    paddingRight: 16,
  },
  switchTitle: {
    fontSize: 15,
    color: '#FFFFFF',
    fontWeight: '500',
  },
  switchSubtitle: {
    fontSize: 12,
    color: '#888',
    marginTop: 2,
  },
  errorText: {
    color: '#FF4444',
    fontSize: 13,
    marginBottom: 16,
  },
  saveButton: {
    backgroundColor: '#FF6B00',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  saveButtonDisabled: {
    opacity: 0.4,
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
});
