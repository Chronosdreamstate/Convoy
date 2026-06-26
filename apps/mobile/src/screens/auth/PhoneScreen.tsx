import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Modal,
} from 'react-native';
import { useRouter } from 'expo-router';
import { authService } from '../../services/AuthService';
import { theme } from '../../theme';

const COUNTRIES = [
  { code: 'US', flag: '🇺🇸', dial: '+1',  label: 'United States'  },
  { code: 'CA', flag: '🇨🇦', dial: '+1',  label: 'Canada'          },
  { code: 'GB', flag: '🇬🇧', dial: '+44', label: 'United Kingdom'  },
  { code: 'AU', flag: '🇦🇺', dial: '+61', label: 'Australia'       },
  { code: 'MX', flag: '🇲🇽', dial: '+52', label: 'Mexico'          },
] as const;

type Country = typeof COUNTRIES[number];

function formatPhone(raw: string, dial: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 10);
  if (dial !== '+1') return d;
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export default function PhoneScreen() {
  const router = useRouter();
  const [country, setCountry] = useState<Country>(COUNTRIES[0]);
  const [digits, setDigits] = useState('');
  const [showPicker, setShowPicker] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChangeText = (text: string) => {
    const raw = text.replace(/\D/g, '').slice(0, 10);
    setDigits(raw);
    if (error) setError(null);
  };

  const handleSendOtp = async () => {
    if (digits.length < 10) {
      setError('Please enter a valid 10-digit phone number.');
      return;
    }
    const e164 = country.dial + digits;
    setError(null);
    setIsLoading(true);
    try {
      const { devOtp } = await authService.requestOtp(e164);
      if (devOtp) {
        Alert.alert('Dev Mode — Your OTP', `Code: ${devOtp}`, [
          { text: 'OK', onPress: () => router.push({ pathname: '/(auth)/otp', params: { phone: e164 } }) },
        ]);
      } else {
        router.push({ pathname: '/(auth)/otp', params: { phone: e164 } });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send OTP. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const selectCountry = (c: Country) => {
    setCountry(c);
    setDigits('');
    setShowPicker(false);
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView style={styles.inner} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>

        <Text style={styles.logo} accessibilityLabel="CONVOY">CONVOY</Text>

        <View style={styles.header}>
          <Text style={styles.title}>Enter your number</Text>
          <Text style={styles.subtitle}>
            We'll send a one-time code to verify your phone number.
          </Text>
        </View>

        <View style={styles.form}>
          {/* Phone input row — bottom-line style, no card border */}
          <View style={styles.inputArea}>
            <TouchableOpacity
              style={styles.countryPicker}
              onPress={() => setShowPicker(true)}
              accessibilityRole="button"
              accessibilityLabel={`Country: ${country.label}, dial code ${country.dial}`}
            >
              <Text style={styles.flag}>{country.flag}</Text>
              <Text style={styles.dialCode}>{country.dial}</Text>
              <Text style={styles.chevron}>▾</Text>
            </TouchableOpacity>

            <View style={styles.divider} />

            <TextInput
              style={styles.input}
              value={formatPhone(digits, country.dial)}
              onChangeText={handleChangeText}
              placeholder="(555) 123-4567"
              placeholderTextColor="#888888"
              keyboardType="phone-pad"
              autoComplete="tel"
              textContentType="telephoneNumber"
              autoFocus
              returnKeyType="send"
              onSubmitEditing={() => { void handleSendOtp(); }}
              accessibilityLabel="Phone number, required"
            />
          </View>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <TouchableOpacity
            style={[styles.button, (isLoading || digits.length < 10) && styles.buttonDisabled]}
            onPress={() => { void handleSendOtp(); }}
            disabled={isLoading || digits.length < 10}
            accessibilityRole="button"
            accessibilityLabel="Continue"
            accessibilityHint="Sends a one-time code to your phone"
            accessibilityState={{ disabled: isLoading || digits.length < 10 }}
          >
            {isLoading
              ? <ActivityIndicator color="#FFFFFF" />
              : <Text style={styles.buttonText}>Continue →</Text>}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {/* Country picker bottom sheet */}
      <Modal
        visible={showPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowPicker(false)}
      >
        <TouchableOpacity
          style={styles.overlay}
          onPress={() => setShowPicker(false)}
          activeOpacity={1}
          accessibilityRole="button"
          accessibilityLabel="Close country picker"
        >
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Select Country</Text>

            {COUNTRIES.map((c) => (
              <TouchableOpacity
                key={c.code}
                style={[styles.countryRow, country.code === c.code && styles.countryRowSelected]}
                onPress={() => selectCountry(c)}
                accessibilityRole="radio"
                accessibilityState={{ checked: country.code === c.code }}
                accessibilityLabel={`${c.label}, ${c.dial}`}
              >
                <Text style={styles.countryFlag}>{c.flag}</Text>
                <Text style={styles.countryLabel}>{c.label}</Text>
                <Text style={styles.countryDial}>{c.dial}</Text>
                {country.code === c.code && <Text style={styles.checkmark}>✓</Text>}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A' },
  inner: { flex: 1, paddingHorizontal: 24, paddingTop: 32 },
  backBtn: { paddingTop: 8, paddingBottom: 16, alignSelf: 'flex-start' },
  backBtnText: { color: '#DC143C', fontSize: 16, fontWeight: '600' },
  logo: {
    fontSize: 32,
    fontWeight: '700',
    color: '#DC143C',
    letterSpacing: 6,
    marginBottom: 32,
  },
  header: { marginBottom: 40 },
  title: { fontSize: 28, fontWeight: '700', color: '#FFFFFF', marginBottom: 8 },
  subtitle: { fontSize: 15, color: '#888888', lineHeight: 22 },
  form: { gap: 20 },
  inputArea: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A2A',
    paddingBottom: 12,
  },
  countryPicker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingRight: 14,
  },
  flag: { fontSize: 22 },
  dialCode: { color: '#FFFFFF', fontSize: 17, fontWeight: '600' },
  chevron: { color: '#888888', fontSize: 10 },
  divider: { width: 1, height: 24, backgroundColor: '#2A2A2A', marginRight: 14 },
  input: {
    flex: 1,
    fontSize: 24,
    color: '#FFFFFF',
    paddingVertical: 0,
  },
  errorText: { color: '#FF4444', fontSize: 13, marginTop: -8 },
  button: {
    backgroundColor: '#DC143C',
    borderRadius: 12,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  // Modal
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  sheet: {
    backgroundColor: '#1C1C1C',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 40,
  },
  sheetHandle: {
    width: 40,
    height: 4,
    backgroundColor: '#2A2A2A',
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 20,
  },
  sheetTitle: {
    color: '#888888',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  countryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#242424',
  },
  countryRowSelected: { opacity: 1 },
  countryFlag: { fontSize: 24 },
  countryLabel: { flex: 1, color: '#FFFFFF', fontSize: 16 },
  countryDial: { color: '#888888', fontSize: 15 },
  checkmark: { color: '#DC143C', fontSize: 16, fontWeight: '700' },
});
