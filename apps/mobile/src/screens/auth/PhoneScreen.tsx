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
} from 'react-native';
import { useRouter } from 'expo-router';
import { authService } from '../../services/AuthService';

function formatPhoneDigits(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)} ${d.slice(3)}`;
  return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
}

export default function PhoneScreen() {
  const router = useRouter();
  const [digits, setDigits] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChangeText = (text: string) => {
    const raw = text.replace(/\D/g, '').slice(0, 10);
    setDigits(raw);
    if (error) setError(null);
  };

  const handleSendOtp = async () => {
    if (digits.length === 0) {
      setError('Please enter your phone number.');
      return;
    }
    if (digits.length !== 10) {
      setError('Please enter a valid 10-digit US phone number.');
      return;
    }

    const e164 = '+1' + digits;
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
      const message = err instanceof Error ? err.message : 'Failed to send OTP. Please try again.';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={styles.inner}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>

        <View style={styles.header}>
          <Text style={styles.title}>Enter your number</Text>
          <Text style={styles.subtitle}>
            We'll send a one-time code to verify your phone number.
          </Text>
        </View>

        <View style={styles.form}>
          <Text style={styles.label}>Phone Number</Text>

          <View style={[styles.inputRow, isFocused && styles.inputRowFocused]}>
            <View style={styles.prefixChip}>
              <Text style={styles.prefixText}>🇺🇸  +1</Text>
            </View>
            <View style={styles.inputDivider} />
            <TextInput
              style={styles.input}
              value={formatPhoneDigits(digits)}
              onChangeText={handleChangeText}
              placeholder="555 123 4567"
              placeholderTextColor="#555555"
              keyboardType="phone-pad"
              autoComplete="tel"
              textContentType="telephoneNumber"
              autoFocus
              returnKeyType="send"
              onSubmitEditing={() => { void handleSendOtp(); }}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              accessibilityLabel="Phone number input"
            />
          </View>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <TouchableOpacity
            style={[styles.button, (isLoading || digits.length < 10) && styles.buttonDisabled]}
            onPress={() => { void handleSendOtp(); }}
            disabled={isLoading || digits.length < 10}
            accessibilityRole="button"
            accessibilityLabel="Send OTP"
            accessibilityState={{ disabled: isLoading || digits.length < 10 }}
          >
            {isLoading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonText}>Send OTP</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  inner: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 32,
    justifyContent: 'flex-start',
  },
  header: {
    marginBottom: 32,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#FFFFFF',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: '#888888',
    lineHeight: 22,
  },
  form: {
    gap: 12,
  },
  backBtn: { paddingTop: 8, paddingBottom: 16, alignSelf: 'flex-start' },
  backBtnText: { color: '#DC143C', fontSize: 16, fontWeight: '600' },
  label: {
    fontSize: 13,
    color: '#AAAAAA',
    marginBottom: 4,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    minHeight: 56,
    overflow: 'hidden',
  },
  inputRowFocused: {
    borderColor: '#DC143C',
  },
  prefixChip: {
    paddingHorizontal: 14,
    paddingVertical: 4,
    justifyContent: 'center',
  },
  prefixText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  inputDivider: {
    width: 1,
    height: 28,
    backgroundColor: '#333333',
    marginVertical: 10,
  },
  input: {
    flex: 1,
    paddingHorizontal: 14,
    fontSize: 17,
    color: '#FFFFFF',
    minHeight: 56,
  },
  errorText: {
    color: '#FF4444',
    fontSize: 13,
    marginTop: 2,
  },
  button: {
    backgroundColor: '#DC143C',
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: 'center',
    marginTop: 8,
    minHeight: 56,
    justifyContent: 'center',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
});
