import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { authService } from '../../services/AuthService';
import { useAuthStore } from '../../stores/authStore';

type Mode = 'signin' | 'signup';

function isValidEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

export default function EmailScreen() {
  const router = useRouter();
  const { setUser, setAccessToken } = useAuthStore();

  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const passwordRef = useRef<TextInput>(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 350,
      useNativeDriver: true,
    }).start();
  }, [fadeAnim]);

  const handleEmailChange = (text: string) => {
    const lower = text.toLowerCase();
    setEmail(lower);
    if (emailError && isValidEmail(lower.trim())) setEmailError(null);
  };

  const handleEmailBlur = () => {
    if (email.trim() && !isValidEmail(email.trim())) {
      setEmailError('Enter a valid email address.');
    } else {
      setEmailError(null);
    }
  };

  const handlePasswordChange = (text: string) => {
    setPassword(text);
    if (passwordError && text.length >= (mode === 'signup' ? 8 : 1)) setPasswordError(null);
  };

  const handleSubmit = async () => {
    const trimmedEmail = email.trim();
    let hasError = false;

    if (!trimmedEmail) {
      setEmailError('Email is required.');
      hasError = true;
    } else if (!isValidEmail(trimmedEmail)) {
      setEmailError('Enter a valid email address.');
      hasError = true;
    } else {
      setEmailError(null);
    }

    if (!password) {
      setPasswordError('Password is required.');
      hasError = true;
    } else if (mode === 'signup' && password.length < 8) {
      setPasswordError('Password must be at least 8 characters.');
      hasError = true;
    } else {
      setPasswordError(null);
    }

    if (hasError) return;

    setSubmitError(null);
    setIsLoading(true);

    try {
      const result =
        mode === 'signin'
          ? await authService.signInEmail(trimmedEmail, password)
          : await authService.signUpEmail(trimmedEmail, password);

      setUser(result.user);
      setAccessToken(result.accessToken);
      router.replace('/(tabs)/map');
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : mode === 'signin'
            ? 'Sign in failed. Please check your credentials.'
            : 'Sign up failed. Please try again.';
      setSubmitError(message);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleMode = () => {
    setMode((prev) => (prev === 'signin' ? 'signup' : 'signin'));
    setSubmitError(null);
    setEmailError(null);
    setPasswordError(null);
    setPassword('');
  };

  const isSubmitDisabled = isLoading || !email.trim() || !password;
  const emailValid = isValidEmail(email.trim());

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={styles.keyboardAvoid}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.inner}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
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

          <Animated.View style={{ opacity: fadeAnim }}>
            <View style={styles.header}>
              <Text style={styles.title}>
                {mode === 'signin' ? 'Welcome back' : 'Create account'}
              </Text>
              <Text style={styles.subtitle}>
                {mode === 'signin'
                  ? 'Sign in with your email and password.'
                  : 'Join CONVOY with your email.'}
              </Text>
            </View>

            <View style={styles.form}>
              <Text style={styles.label}>Email address</Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={[styles.input, styles.inputFlex, emailError ? styles.inputError : null]}
                  value={email}
                  onChangeText={handleEmailChange}
                  onBlur={handleEmailBlur}
                  placeholder="you@example.com"
                  placeholderTextColor="#555555"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                  textContentType="emailAddress"
                  returnKeyType="next"
                  onSubmitEditing={() => passwordRef.current?.focus()}
                  accessibilityLabel="Email address, required"
                />
                {emailValid ? (
                  <Text style={styles.validIcon}>✓</Text>
                ) : null}
              </View>
              {emailError ? <Text style={styles.fieldError}>{emailError}</Text> : null}

              <Text style={[styles.label, styles.labelSpacing]}>Password</Text>
              <View style={styles.inputRow}>
                <TextInput
                  ref={passwordRef}
                  style={[styles.input, styles.inputFlex, passwordError ? styles.inputError : null]}
                  value={password}
                  onChangeText={handlePasswordChange}
                  placeholder="••••••••"
                  placeholderTextColor="#555555"
                  secureTextEntry={!showPassword}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  textContentType={mode === 'signup' ? 'newPassword' : 'password'}
                  returnKeyType="done"
                  onSubmitEditing={handleSubmit}
                  accessibilityLabel="Password, required"
                  accessibilityHint={mode === 'signup' ? 'Minimum 8 characters' : undefined}
                />
                <TouchableOpacity
                  style={styles.eyeBtn}
                  onPress={() => setShowPassword((v) => !v)}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={styles.eyeIcon}>{showPassword ? '🙈' : '👁'}</Text>
                </TouchableOpacity>
              </View>
              {passwordError ? <Text style={styles.fieldError}>{passwordError}</Text> : null}

              {submitError ? <Text style={styles.submitError}>{submitError}</Text> : null}

              <TouchableOpacity
                style={[styles.button, isSubmitDisabled && styles.buttonDisabled]}
                onPress={handleSubmit}
                disabled={isSubmitDisabled}
                accessibilityRole="button"
                accessibilityLabel={mode === 'signin' ? 'Sign In' : 'Sign Up'}
                accessibilityState={{ disabled: isSubmitDisabled }}
              >
                {isLoading ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.buttonText}>{mode === 'signin' ? 'Sign In' : 'Sign Up'}</Text>
                )}
              </TouchableOpacity>

              <View style={styles.toggleRow}>
                <Text style={styles.toggleText}>
                  {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
                </Text>
                <TouchableOpacity
                  onPress={toggleMode}
                  accessibilityRole="button"
                  accessibilityLabel={mode === 'signin' ? 'Switch to Sign Up' : 'Switch to Sign In'}
                >
                  <Text style={styles.toggleLink}>
                    {mode === 'signin' ? 'Sign Up' : 'Sign In'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  keyboardAvoid: {
    flex: 1,
  },
  inner: {
    paddingHorizontal: 24,
    paddingTop: 32,
    paddingBottom: 48,
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
  backBtn: { paddingTop: 8, paddingBottom: 16, alignSelf: 'flex-start' },
  backBtnText: { color: '#DC143C', fontSize: 16, fontWeight: '600' },
  form: {
    gap: 8,
  },
  label: {
    fontSize: 13,
    color: '#AAAAAA',
  },
  labelSpacing: {
    marginTop: 8,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputFlex: {
    flex: 1,
  },
  input: {
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: '#FFFFFF',
  },
  inputError: {
    borderColor: '#FF4444',
  },
  validIcon: {
    color: '#22C55E',
    fontSize: 18,
    fontWeight: '700',
    marginLeft: 10,
  },
  eyeBtn: {
    marginLeft: 10,
    padding: 4,
  },
  eyeIcon: {
    fontSize: 18,
  },
  fieldError: {
    color: '#FF4444',
    fontSize: 12,
    marginTop: 4,
    marginLeft: 4,
  },
  submitError: {
    color: '#FF4444',
    fontSize: 13,
    marginTop: 8,
    textAlign: 'center',
  },
  button: {
    backgroundColor: '#DC143C',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 12,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 16,
  },
  toggleText: {
    color: '#666666',
    fontSize: 14,
  },
  toggleLink: {
    color: '#DC143C',
    fontSize: 14,
    fontWeight: '600',
  },
});
