import React, { useEffect, useRef } from 'react';
import {
  Animated,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Linking,
  Platform,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { authService } from '../../services/AuthService';
import { useAuthStore } from '../../stores/authStore';
import { theme } from '../../theme';
import { GoogleSignin } from '@react-native-google-signin/google-signin';

GoogleSignin.configure({
  iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  offlineAccess: true,
});

const PRIVACY_POLICY_URL = 'https://convoy.app/privacy';
const TERMS_URL = 'https://convoy.app/terms';

export default function WelcomeScreen() {
  const router = useRouter();
  const { setUser, setAccessToken } = useAuthStore();

  // Hero fade-in + slide-up on mount
  const heroOpacity = useRef(new Animated.Value(0)).current;
  const heroTranslate = useRef(new Animated.Value(30)).current;

  // Accent pulse loop
  const accentScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(heroOpacity, {
        toValue: 1,
        duration: 700,
        useNativeDriver: true,
      }),
      Animated.timing(heroTranslate, {
        toValue: 0,
        duration: 700,
        useNativeDriver: true,
      }),
    ]).start();

    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(accentScale, {
          toValue: 1.15,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(accentScale, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [heroOpacity, heroTranslate, accentScale]);

  const handleOpenUrl = (url: string) => {
    Linking.openURL(url).catch(() => {});
  };

  const handleAppleSignIn = async () => {
    if (Platform.OS !== 'ios') return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const AppleAuth = require('expo-apple-authentication');
      const credential = await AppleAuth.signInAsync({
        requestedScopes: [
          AppleAuth.AppleAuthenticationScope.FULL_NAME,
          AppleAuth.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (credential.identityToken) {
        const result = await authService.signInSocial('apple', credential.identityToken);
        setUser(result.user);
        setAccessToken(result.accessToken);
        router.replace('/(tabs)/map');
      }
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'ERR_REQUEST_CANCELED') return;
      Alert.alert('Sign In Failed', 'Could not sign in with Apple. Please try another method.');
    }
  };

  const handleGoogleSignIn = async () => {
    if (!process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID && !process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID) {
      Alert.alert('Not configured', 'Google Sign-In requires EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID and EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID in your .env file.');
      return;
    }
    try {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      const userInfo = await GoogleSignin.signIn();
      const idToken = userInfo.data?.idToken ?? null;
      if (!idToken) { Alert.alert('Sign In Failed', 'No ID token returned from Google.'); return; }
      const result = await authService.signInSocial('google', idToken);
      setUser(result.user);
      setAccessToken(result.accessToken);
      router.replace('/(tabs)/map');
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'SIGN_IN_CANCELLED' || code === '12501') return;
      Alert.alert('Sign In Failed', 'Could not sign in with Google. Please try another method.');
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <Animated.View
        style={[
          styles.heroSection,
          { opacity: heroOpacity, transform: [{ translateY: heroTranslate }] },
        ]}
        accessibilityLabel="CONVOY app logo"
        accessibilityRole="image"
      >
        {/* Decorative convoy of cars */}
        <Text style={styles.convoyEmojis}>🚗🚙🚕</Text>
        <Text style={styles.appName}>CONVOY</Text>
        {/* Pulsing crimson underline */}
        <Animated.View style={[styles.logoAccent, { transform: [{ scaleX: accentScale }] }]} />
        <Text style={styles.tagline}>Drive together. Stay connected.</Text>
      </Animated.View>

      <View style={styles.buttonSection}>
        {/* Phone auth */}
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => router.push('/(auth)/phone')}
          accessibilityRole="button"
          accessibilityLabel="Sign in with Phone"
          accessibilityHint="Opens phone number entry screen"
        >
          <Text style={styles.primaryButtonText}>📱  Sign in with Phone</Text>
        </TouchableOpacity>

        {/* Divider */}
        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or</Text>
          <View style={styles.dividerLine} />
        </View>

        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => router.push('/(auth)/email')}
          accessibilityRole="button"
          accessibilityLabel="Sign in with Email"
          accessibilityHint="Opens email and password entry screen"
        >
          <Text style={styles.secondaryButtonText}>✉️  Sign in with Email</Text>
        </TouchableOpacity>

        {/* Apple sign-in — black with white text */}
        {Platform.OS === 'ios' && (
          <TouchableOpacity
            style={styles.appleButton}
            onPress={() => { void handleAppleSignIn(); }}
            accessibilityRole="button"
            accessibilityLabel="Sign in with Apple"
            accessibilityHint="Signs you in with your Apple ID"
          >
            <Text style={styles.appleButtonText}> Sign in with Apple</Text>
          </TouchableOpacity>
        )}

        {/* Google sign-in */}
        <TouchableOpacity
          style={styles.googleButton}
          onPress={() => { void handleGoogleSignIn(); }}
          accessibilityRole="button"
          accessibilityLabel="Sign in with Google"
          accessibilityHint="Signs you in with your Google account"
        >
          <Text style={styles.googleButtonText}>G  Sign in with Google</Text>
        </TouchableOpacity>
      </View>

      {/* Legal */}
      <View style={styles.legalSection}>
        <Text style={styles.legalText}>By continuing, you agree to our </Text>
        <View style={styles.legalLinks}>
          <TouchableOpacity
            onPress={() => handleOpenUrl(TERMS_URL)}
            accessibilityRole="link"
            accessibilityLabel="Terms of Service"
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
          >
            <Text style={styles.legalLink}>Terms of Service</Text>
          </TouchableOpacity>
          <Text style={styles.legalText}> and </Text>
          <TouchableOpacity
            onPress={() => handleOpenUrl(PRIVACY_POLICY_URL)}
            accessibilityRole="link"
            accessibilityLabel="Privacy Policy"
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
          >
            <Text style={styles.legalLink}>Privacy Policy</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg,
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.xl,
  },
  heroSection: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  convoyEmojis: {
    fontSize: 32,
    letterSpacing: 8,
    marginBottom: theme.spacing.md,
  },
  appName: {
    ...theme.typography.hero,
    color: theme.colors.text,
  },
  logoAccent: {
    width: 80,
    height: 3,
    backgroundColor: theme.colors.accent,
    borderRadius: 2,
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  tagline: {
    fontSize: 16,
    color: theme.colors.textMuted,
    letterSpacing: 0.5,
    textAlign: 'center',
  },
  buttonSection: {
    paddingBottom: theme.spacing.sm,
  },
  primaryButton: {
    backgroundColor: theme.colors.accent,
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: theme.spacing.lg,
    alignItems: 'center',
    minHeight: 56,
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 14,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.border,
  },
  dividerText: {
    color: theme.colors.textSubtle,
    fontSize: 13,
    marginHorizontal: 12,
  },
  secondaryButton: {
    backgroundColor: theme.colors.card,
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: theme.spacing.lg,
    alignItems: 'center',
    minHeight: 56,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  secondaryButtonText: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  appleButton: {
    backgroundColor: '#000000',
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: theme.spacing.lg,
    alignItems: 'center',
    minHeight: 56,
    justifyContent: 'center',
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#333333',
  },
  appleButtonText: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  googleButton: {
    backgroundColor: theme.colors.card,
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: theme.spacing.lg,
    alignItems: 'center',
    minHeight: 56,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#4285F4',
    marginTop: 10,
  },
  googleButtonText: {
    color: '#4285F4',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  legalSection: {
    alignItems: 'center',
    paddingTop: theme.spacing.lg,
  },
  legalLinks: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  legalText: {
    color: theme.colors.textMuted,
    ...theme.typography.tiny,
  },
  legalLink: {
    color: theme.colors.accent,
    ...theme.typography.tiny,
    textDecorationLine: 'underline',
  },
});
