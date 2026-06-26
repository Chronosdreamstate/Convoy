import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Animated,
  StyleSheet,
  ActivityIndicator,
  SafeAreaView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { apiClient } from '../../services/apiClient';

const VEHICLE_TYPES = [
  { key: 'sports', label: '🏎️ Sports' },
  { key: 'truck', label: '🛻 Truck' },
  { key: 'suv', label: '🚙 SUV' },
  { key: 'sedan', label: '🚗 Sedan' },
  { key: 'moto', label: '🏍️ Moto' },
];

export default function AddVehiclePromptScreen() {
  const router = useRouter();
  const [vehicleName, setVehicleName] = useState('');
  const [selectedType, setSelectedType] = useState<string>('sedan');
  const [loading, setLoading] = useState(false);

  const scaleAnim = useRef(new Animated.Value(0.8)).current;

  useEffect(() => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      friction: 4,
      tension: 60,
      useNativeDriver: true,
    }).start();
  }, []);

  const handleSubmit = async () => {
    if (!vehicleName.trim()) return;
    setLoading(true);
    try {
      await apiClient.post('/api/v1/vehicles', {
        model: vehicleName.trim(),
        type: selectedType,
      });
    } catch {
      // non-blocking — proceed regardless
    } finally {
      setLoading(false);
      router.replace('/(onboarding)/find-group' as never);
    }
  };

  const handleSkip = () => {
    router.replace('/(onboarding)/find-group' as never);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Animated.Text style={[styles.emoji, { transform: [{ scale: scaleAnim }] }]}>
          🚗
        </Animated.Text>

        <Text style={styles.heading}>Add your ride</Text>
        <Text style={styles.body}>Tell the convoy what you&apos;re driving</Text>

        <TextInput
          style={styles.input}
          placeholder="e.g. 2021 Subaru WRX STI"
          placeholderTextColor="#555"
          value={vehicleName}
          onChangeText={setVehicleName}
          maxLength={60}
          autoCapitalize="words"
          returnKeyType="done"
          onSubmitEditing={handleSubmit}
        />

        <View style={styles.pillRow}>
          {VEHICLE_TYPES.map((t) => (
            <TouchableOpacity
              key={t.key}
              style={[styles.pill, selectedType === t.key && styles.pillActive]}
              onPress={() => setSelectedType(t.key)}
              activeOpacity={0.8}
            >
              <Text style={[styles.pillText, selectedType === t.key && styles.pillTextActive]}>
                {t.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity
          style={[styles.submitBtn, !vehicleName.trim() && styles.submitBtnDisabled]}
          onPress={handleSubmit}
          disabled={!vehicleName.trim() || loading}
          activeOpacity={0.85}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.submitBtnText}>Add My Ride</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity onPress={handleSkip} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={styles.skipText}>Skip for now →</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0A0A0A' },
  container: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 40,
    gap: 16,
  },
  emoji: { fontSize: 80 },
  heading: { fontSize: 28, fontWeight: '700', color: '#FFFFFF', textAlign: 'center' },
  body: { fontSize: 15, color: '#888888', textAlign: 'center', marginBottom: 8 },
  input: {
    width: '100%',
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: '#FFFFFF',
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
    marginVertical: 4,
  },
  pill: {
    backgroundColor: '#1C1C1C',
    borderRadius: 100,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  pillActive: { backgroundColor: '#DC143C', borderColor: '#DC143C' },
  pillText: { fontSize: 14, color: '#888888' },
  pillTextActive: { color: '#FFFFFF', fontWeight: '600' },
  submitBtn: {
    width: '100%',
    backgroundColor: '#DC143C',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitBtnText: { fontSize: 16, fontWeight: '700', color: '#FFFFFF' },
  skipText: { fontSize: 14, color: '#555555', marginTop: 4 },
});
