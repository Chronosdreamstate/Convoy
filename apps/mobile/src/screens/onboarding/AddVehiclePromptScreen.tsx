import React, { useState, useRef, useEffect, useMemo } from 'react';
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
import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { apiClient } from '../../services/apiClient';
import { onboardingState } from '../../utils/onboardingState';
import { useTheme } from '../../theme';

type VehicleIconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

const VEHICLE_TYPES: Array<{ key: string; icon: VehicleIconName; label: string }> = [
  { key: 'sedan', icon: 'car', label: 'Car' },
  { key: 'moto', icon: 'motorbike', label: 'Motorcycle' },
  { key: 'suv', icon: 'truck', label: 'SUV/Truck' },
  { key: 'van', icon: 'van-utility', label: 'Van/RV' },
  { key: 'sports', icon: 'car-sports', label: 'Track Car' },
];

export default function AddVehiclePromptScreen() {
  const router = useRouter();
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [vehicleName, setVehicleName] = useState('');
  const [selectedType, setSelectedType] = useState<string>('sedan');
  const [loading, setLoading] = useState(false);

  const scaleAnim = useRef(new Animated.Value(0.8)).current;
  const pillScales = useRef(VEHICLE_TYPES.map(() => new Animated.Value(1))).current;
  // Guards against a double-tap (submit or skip) firing two navigations.
  const isLeavingRef = useRef(false);

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
    if (!vehicleName.trim() || isLeavingRef.current) return;
    isLeavingRef.current = true;
    setLoading(true);
    try {
      await apiClient.post('/api/v1/vehicles', {
        name: vehicleName.trim(),
        type: selectedType,
      });
    } catch {
      // non-blocking — proceed regardless
    } finally {
      setLoading(false);
      await onboardingState.markComplete('vehicle');
      router.replace('/(onboarding)/ptt-tutorial' as never);
    }
  };

  const handleSkip = async () => {
    if (isLeavingRef.current) return;
    isLeavingRef.current = true;
    await onboardingState.markSkipped('vehicle');
    router.replace('/(onboarding)/ptt-tutorial' as never);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {/* Decorative hero illustration */}
        <Animated.Text style={[styles.emoji, { transform: [{ scale: scaleAnim }] }]}>
          🚗
        </Animated.Text>

        <Text style={styles.heading}>What do you drive?</Text>
        <Text style={styles.body}>Shown to other convoy members</Text>

        <TextInput
          style={styles.input}
          placeholder="e.g. 2021 Subaru WRX STI"
          placeholderTextColor={theme.colors.textSubtle}
          value={vehicleName}
          onChangeText={setVehicleName}
          maxLength={60}
          autoCapitalize="words"
          returnKeyType="done"
          onSubmitEditing={handleSubmit}
          accessibilityLabel="Vehicle name"
        />

        <View style={styles.pillRow}>
          {VEHICLE_TYPES.map((t, idx) => {
            const isSelected = selectedType === t.key;
            return (
              <Animated.View key={t.key} style={{ transform: [{ scale: pillScales[idx] }] }}>
                <TouchableOpacity
                  style={[styles.pill, isSelected && styles.pillActive]}
                  onPress={() => handleSelectType(t.key, idx)}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={t.label}
                  accessibilityState={{ selected: isSelected }}
                >
                  <MaterialCommunityIcons
                    name={t.icon}
                    size={22}
                    color={isSelected ? theme.colors.text : theme.colors.textMuted}
                  />
                  <Text style={[styles.pillText, isSelected && styles.pillTextActive]}>
                    {t.label}
                  </Text>
                </TouchableOpacity>
              </Animated.View>
            );
          })}
        </View>

        <TouchableOpacity
          style={[styles.submitBtn, !vehicleName.trim() && styles.submitBtnDisabled]}
          onPress={handleSubmit}
          disabled={!vehicleName.trim() || loading}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Add My Ride"
          accessibilityState={{ disabled: !vehicleName.trim() || loading, busy: loading }}
        >
          {loading ? (
            <ActivityIndicator color={theme.colors.text} />
          ) : (
            <Text style={styles.submitBtnText}>Add My Ride</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          onPress={handleSkip}
          activeOpacity={0.7}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          accessibilityRole="button"
          accessibilityLabel="Skip for now"
        >
          <Text style={styles.skipText}>Skip for now →</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: theme.colors.bg },
    container: {
      flexGrow: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 24,
      paddingVertical: 40,
      gap: 16,
    },
    emoji: { fontSize: 80 },
    heading: { fontSize: 28, fontWeight: '700', color: theme.colors.text, textAlign: 'center' },
    body: { fontSize: 15, color: theme.colors.textMuted, textAlign: 'center', marginBottom: 8 },
    input: {
      width: '100%',
      backgroundColor: theme.colors.card,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.colors.border,
      paddingHorizontal: 16,
      paddingVertical: 14,
      fontSize: 16,
      color: theme.colors.text,
    },
    pillRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'center',
      gap: 8,
      marginVertical: 4,
    },
    pill: {
      backgroundColor: theme.colors.card,
      borderRadius: 14,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      alignItems: 'center',
      gap: 4,
      minWidth: 72,
    },
    pillActive: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
    pillText: { fontSize: 11, color: theme.colors.textMuted, textAlign: 'center' },
    pillTextActive: { color: theme.colors.text, fontWeight: '600' },
    submitBtn: {
      width: '100%',
      backgroundColor: theme.colors.accent,
      borderRadius: 12,
      paddingVertical: 16,
      alignItems: 'center',
      marginTop: 8,
    },
    submitBtnDisabled: { opacity: 0.4 },
    submitBtnText: { fontSize: 16, fontWeight: '700', color: theme.colors.text },
    skipText: { fontSize: 14, color: theme.colors.textSubtle, marginTop: 4 },
  });
}
