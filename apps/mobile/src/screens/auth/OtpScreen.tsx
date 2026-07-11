import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  Animated,
  ScrollView,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { authService } from '../../services/AuthService';
import { useAuthStore } from '../../stores/authStore';
import { onboardingState } from '../../utils/onboardingState';
import { useTheme } from '../../theme';

const DIGIT_COUNT = 6;

// Text that always sits on the crimson accent fill — stays light in both themes.
const ON_ACCENT = '#FFFFFF';

export default function OtpScreen() {
  const router = useRouter();
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const params = useLocalSearchParams<{ phone: string }>();
  const phone = Array.isArray(params.phone) ? params.phone[0] : params.phone;
  const { setUser, setAccessToken, setIsFirstLogin } = useAuthStore();

  const [otp, setOtp] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [resendMessage, setResendMessage] = useState<string | null>(null);

  const inputRef = useRef<TextInput>(null);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoSubmitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shakeAnim = useRef(new Animated.Value(0)).current;

  const startCooldown = () => {
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    cooldownRef.current = setInterval(() => {
      setResendCooldown((s) => {
        if (s <= 1) { clearInterval(cooldownRef.current!); cooldownRef.current = null; return 0; }
        return s - 1;
      });
    }, 1000);
  };

  useEffect(() => {
    startCooldown();
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current);
      if (autoSubmitRef.current) clearTimeout(autoSubmitRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const triggerShake = () => {
    shakeAnim.setValue(0);
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 8, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -8, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 4, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  };

  const handleVerify = async (code?: string) => {
    const value = code ?? otp;
    if (value.length !== 6) { setError('Please enter the 6-digit code.'); triggerShake(); return; }
    if (!phone) { setError('Phone number is missing. Please go back and try again.'); return; }
    setError(null);
    setIsVerifying(true);
    try {
      const result = await authService.verifyOtp(phone, value);
      const onboardingDone = await SecureStore.getItemAsync('onboarding_complete').catch(() => '1');
      setUser(result.user);
      setAccessToken(result.accessToken);
      if (!onboardingDone) {
        setIsFirstLogin(true);
        // Resume at whichever onboarding step is next, rather than always
        // restarting from the first step for a returning-but-incomplete user.
        const resumeRoute = await onboardingState.getResumeRoute();
        router.replace((resumeRoute ?? '/(onboarding)/vehicle') as never);
      } else {
        router.replace('/(tabs)/map');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Verification failed. Please try again.';
      setError(message);
      triggerShake();
    } finally {
      setIsVerifying(false);
    }
  };

  const handleOtpChange = (text: string) => {
    const digits = text.replace(/[^0-9]/g, '').slice(0, DIGIT_COUNT);
    setOtp(digits);
    setError(null);
    if (autoSubmitRef.current) { clearTimeout(autoSubmitRef.current); autoSubmitRef.current = null; }
    if (digits.length === DIGIT_COUNT) {
      autoSubmitRef.current = setTimeout(() => { void handleVerify(digits); }, 300);
    }
  };

  const handleResend = async () => {
    if (!phone || resendCooldown > 0) return;
    setResendMessage(null); setError(null); setIsResending(true);
    try {
      const { devOtp } = await authService.requestOtp(phone);
      setResendMessage(devOtp ? `Dev mode — new OTP: ${devOtp}` : 'A new code has been sent.');
      setOtp('');
      setResendCooldown(30);
      startCooldown();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resend OTP.');
    } finally {
      setIsResending(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView style={styles.keyboardAvoid} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView
          contentContainerStyle={styles.inner}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => router.back()}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.backBtnText}>← Back</Text>
          </TouchableOpacity>

          <Text style={styles.logo} accessibilityLabel="CORTEGE">CORTEGE</Text>

          <View style={styles.header}>
            <Text style={styles.title}>Enter the code</Text>
            <Text style={styles.subtitle}>
              We sent a 6-digit code to{'\n'}
              <Text style={styles.phoneNumber}>{phone ?? 'your phone'}</Text>
            </Text>
          </View>

          <View style={styles.form}>
            {/* Hidden input captures keyboard; digit boxes are the visual layer */}
            <TextInput
              ref={inputRef}
              value={otp}
              onChangeText={handleOtpChange}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              maxLength={DIGIT_COUNT}
              style={styles.hiddenInput}
              autoFocus
              accessibilityLabel="Verification code, 6 digits"
            />

            <Animated.View style={[styles.digitRow, { transform: [{ translateX: shakeAnim }] }]}>
              {Array.from({ length: DIGIT_COUNT }).map((_, i) => (
                <TouchableOpacity
                  key={i}
                  style={[
                    styles.digitBox,
                    otp.length === i && styles.digitBoxActive,
                    otp[i] !== undefined && styles.digitBoxFilled,
                  ]}
                  onPress={() => inputRef.current?.focus()}
                  activeOpacity={0.7}
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                >
                  <Text style={styles.digitText}>{otp[i] ?? ''}</Text>
                </TouchableOpacity>
              ))}
            </Animated.View>

            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            {resendMessage ? <Text style={styles.successText}>{resendMessage}</Text> : null}

            <TouchableOpacity
              style={[styles.button, (isVerifying || otp.length !== DIGIT_COUNT) && styles.buttonDisabled]}
              onPress={() => { void handleVerify(); }}
              disabled={isVerifying || otp.length !== DIGIT_COUNT}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Verify code"
              accessibilityState={{ disabled: isVerifying || otp.length !== DIGIT_COUNT }}
            >
              {isVerifying
                ? <ActivityIndicator color={ON_ACCENT} />
                : <Text style={styles.buttonText}>Verify</Text>}
            </TouchableOpacity>

            <View style={styles.resendRow}>
              <Text style={styles.resendText}>Didn't get a code? </Text>
              <TouchableOpacity
                onPress={() => { void handleResend(); }}
                disabled={isResending || resendCooldown > 0}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={resendCooldown > 0 ? `Resend code available in ${resendCooldown} seconds` : 'Resend code'}
                accessibilityState={{ disabled: isResending || resendCooldown > 0 }}
              >
                {isResending ? (
                  <ActivityIndicator size="small" color={theme.colors.accent} />
                ) : resendCooldown > 0 ? (
                  <Text style={styles.resendDisabled}>Resend code in {resendCooldown}s</Text>
                ) : (
                  <Text style={styles.resendLink}>Resend code</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.colors.bg },
    keyboardAvoid: { flex: 1 },
    inner: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.xl,
      paddingBottom: theme.spacing.xxl,
    },
    backBtn: { paddingTop: 8, paddingBottom: 16, alignSelf: 'flex-start' },
    backBtnText: { color: theme.colors.accent, fontSize: 16, fontWeight: '600' },
    // Matches the CORTEGE wordmark treatment on PhoneScreen/EmailScreen (same
    // fontSize/weight/color/letterSpacing/centering) — previously a one-off
    // style that was bigger, bolder-colored, and left-aligned on this screen only.
    logo: {
      fontSize: 24,
      fontWeight: '900',
      color: theme.colors.text,
      letterSpacing: 6,
      marginBottom: theme.spacing.xl,
      textAlign: 'center',
    },
    header: { marginBottom: 32 },
    title: { fontSize: 28, fontWeight: '700', color: theme.colors.text, marginBottom: 8 },
    subtitle: { fontSize: 15, color: theme.colors.textMuted, lineHeight: 22 },
    phoneNumber: { color: theme.colors.text, fontWeight: '600' },
    form: { gap: 16 },
    hiddenInput: { position: 'absolute', opacity: 0, width: 1, height: 1 },
    digitRow: { flexDirection: 'row', justifyContent: 'space-between' },
    digitBox: {
      width: 44,
      height: 56,
      borderRadius: 8,
      backgroundColor: theme.colors.card,
      borderWidth: 1,
      borderColor: theme.colors.border,
      justifyContent: 'center',
      alignItems: 'center',
    },
    digitBoxActive: { borderColor: theme.colors.accent },
    digitBoxFilled: { backgroundColor: theme.colors.cardElevated },
    digitText: { color: theme.colors.text, fontSize: 22, fontWeight: '700' },
    errorText: { color: theme.colors.error, fontSize: 13 },
    successText: { color: theme.colors.success, fontSize: 13 },
    // Pill shape + glow shadow — matches the primary CTA on WelcomeScreen/
    // PhoneScreen/EmailScreen instead of the plain rounded-rect button this
    // screen used to have.
    button: {
      backgroundColor: theme.colors.accent,
      borderRadius: 28,
      height: 56,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 4,
      shadowColor: theme.colors.accent,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.35,
      shadowRadius: 12,
      elevation: 6,
    },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: ON_ACCENT, fontSize: 16, fontWeight: '700' },
    resendRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
    resendText: { color: theme.colors.textMuted, fontSize: 14 },
    resendLink: { color: theme.colors.accent, fontSize: 14, fontWeight: '600' },
    resendDisabled: { color: theme.colors.textSubtle, fontSize: 14 },
  });
}
