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
  { key: 'sedan', icon: '🚗', label: 'Car' },
  { key: 'moto', icon: '🏍️', label: 'Motorcycle' },
  { key: 'suv', icon: '🚙', label: 'SUV/Truck' },
  { key: 'van', icon: '🚌', label: 'Van/RV' },
  { key: 'sports', icon: '🏎️', label: 'Track Car' },
];

export default function AddVehiclePromptScreen() {
  const router = useRouter();
  const [vehicleName, setVehicleName] = useState('');
  const [selectedType, setSelectedType] = useState<string>('sedan');
  const [loading, setLoading] = useState(false);

  const scaleAnim = useRef(new Animated.Value(0.8)).current;
  const pillScales = useRef(VEHICLE_TYPES.map(() => new Animated.Value(1))).current;

  useEffect(() => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      friction: 4,
      tension: 60,
      useNativeDriver: true,
    }).start();
  }, []);

  const handleSelectType = (key: string, idx: number) => {
    setSelectedType(key);
    Animated.sequence([
      Animated.spring(pillScales[idx], { toValue: 0.88, useNativeDriver: true, speed: 30, bounciness: 0 }),
      Animated.spring(pillScales[idx], { toValue: 1.1, useNativeDriver: true, speed: 20, bounciness: 12 }),
      Animated.spring(pillScales[idx], { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 6 }),
    ]).start();
  };

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
      router.replace('/(onboarding)/ptt-tutorial' as never);
    }
  };

  const handleSkip = () => {
    router.replace('/(onboarding)/ptt-tutorial' as never);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Animated.Text style={[styles.emoji, { transform: [{ scale: scaleAnim }] }]}>
          🚗
        </Animated.Text>

        <Text style={styles.heading}>What do you drive?</Text>
        <Text style={styles.body}>Shown to other convoy members</Text>

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
          {VEHICLE_TYPES.map((t, idx) => (
            <Animated.View key={t.key} style={{ transform: [{ scale: pillScales[idx] }] }}>
              <TouchableOpacity
                style={[styles.pill, selectedType === t.key && styles.pillActive]}
                onPress={() => handleSelectType(t.key, idx)}
                activeOpacity={0.8}
              >
                <Text style={styles.pillIcon}>{t.icon}</Text>
                <Text style={[styles.pillText, selectedType === t.key && styles.pillTextActive]}>
                  {t.label}
                </Text>
              </TouchableOpacity>
            </Animated.View>
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
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    alignItems: 'center',
    gap: 4,
    minWidth: 72,
  },
  pillActive: { backgroundColor: '#DC143C', borderColor: '#DC143C' },
  pillIcon: { fontSize: 22 },
  pillText: { fontSize: 11, color: '#888888', textAlign: 'center' },
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
