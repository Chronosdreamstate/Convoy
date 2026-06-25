import React, { useEffect, useRef, useState } from 'react';
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
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { authService } from '../../services/AuthService';
import { useAuthStore } from '../../stores/authStore';

export default function OtpScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ phone: string }>();
  const phone = Array.isArray(params.phone) ? params.phone[0] : params.phone;
  const { setUser, setAccessToken } = useAuthStore();

  const [otp, setOtp] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [resendMessage, setResendMessage] = useState<string | null>(null);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => { if (cooldownRef.current) clearInterval(cooldownRef.current); };
  }, []);

  const handleVerify = async () => {
    if (otp.length !== 6) {
      setError('Please enter the 6-digit code.');
      return;
    }
    if (!phone) {
      setError('Phone number is missing. Please go back and try again.');
      return;
    }

    setError(null);
    setIsVerifying(true);

    try {
      const result = await authService.verifyOtp(phone, otp);
      setUser(result.user);
      setAccessToken(result.accessToken);
      // Navigate to the main app
      router.replace('/(tabs)/map');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Verification failed. Please try again.';
      setError(message);
    } finally {
      setIsVerifying(false);
    }
  };

  const handleResend = async () => {
    if (!phone || resendCooldown > 0) return;

    setResendMessage(null);
    setError(null);
    setIsResending(true);

    try {
      const { devOtp } = await authService.requestOtp(phone);
      if (devOtp) {
        setResendMessage(`Dev mode — new OTP: ${devOtp}`);
      } else {
        setResendMessage('A new code has been sent.');
      }
      setOtp('');
      setResendCooldown(30);
      cooldownRef.current = setInterval(() => {
        setResendCooldown((s) => {
          if (s <= 1) {
            clearInterval(cooldownRef.current!);
            cooldownRef.current = null;
            return 0;
          }
          return s - 1;
        });
      }, 1000);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to resend OTP.';
      setError(message);
    } finally {
      setIsResending(false);
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
          accessibilityLabel="Go back"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>

        <View style={styles.header}>
          <Text style={styles.title}>Enter the code</Text>
          <Text style={styles.subtitle}>
            We sent a 6-digit code to{'\n'}
            <Text style={styles.phoneNumber}>{phone ?? 'your phone'}</Text>
          </Text>
        </View>

        <View style={styles.form}>
          <TextInput
            style={styles.otpInput}
            value={otp}
            onChangeText={(text) => {
              setOtp(text.replace(/[^0-9]/g, '').slice(0, 6));
              setError(null);
            }}
            placeholder="••••••"
            placeholderTextColor="#555555"
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            returnKeyType="done"
            onSubmitEditing={handleVerify}
            accessibilityLabel="OTP input"
          />

          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          {resendMessage ? <Text style={styles.successText}>{resendMessage}</Text> : null}

          <TouchableOpacity
            style={[styles.button, (isVerifying || otp.length !== 6) && styles.buttonDisabled]}
            onPress={handleVerify}
            disabled={isVerifying || otp.length !== 6}
            accessibilityRole="button"
            accessibilityLabel="Verify OTP"
          >
            {isVerifying ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonText}>Verify</Text>
            )}
          </TouchableOpacity>

          <View style={styles.resendRow}>
            <Text style={styles.resendText}>Didn't get a code? </Text>
            <TouchableOpacity
              onPress={handleResend}
              disabled={isResending || resendCooldown > 0}
              accessibilityRole="button"
              accessibilityLabel="Resend OTP"
            >
              {isResending ? (
                <ActivityIndicator size="small" color="#DC143C" />
              ) : resendCooldown > 0 ? (
                <Text style={[styles.resendLink, { color: '#555555' }]}>Resend in {resendCooldown}s</Text>
              ) : (
                <Text style={styles.resendLink}>Resend OTP</Text>
              )}
            </TouchableOpacity>
          </View>
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
  phoneNumber: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  backBtn: { paddingTop: 8, paddingBottom: 16, alignSelf: 'flex-start' },
  backBtnText: { color: '#DC143C', fontSize: 16, fontWeight: '600' },
  form: {
    gap: 12,
  },
  otpInput: {
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 16,
    paddingVertical: 18,
    fontSize: 28,
    color: '#FFFFFF',
    letterSpacing: 12,
    textAlign: 'center',
  },
  errorText: {
    color: '#FF4444',
    fontSize: 13,
  },
  successText: {
    color: '#44FF88',
    fontSize: 13,
  },
  button: {
    backgroundColor: '#DC143C',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  resendRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  resendText: {
    color: '#666666',
    fontSize: 14,
  },
  resendLink: {
    color: '#DC143C',
    fontSize: 14,
    fontWeight: '600',
  },
});
