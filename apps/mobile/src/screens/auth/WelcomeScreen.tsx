import React, { useEffect, useRef, useState } from 'react';
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
  Dimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { authService } from '../../services/AuthService';
import { useAuthStore } from '../../stores/authStore';
import { theme } from '../../theme';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { useAccessibilitySettings } from '../../hooks/useAccessibilitySettings';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const SLIDES = [
  {
    emoji: '🚗',
    title: 'Welcome to Convoy',
    body: 'Navigate together. Stay connected.',
  },
  {
    emoji: '📡',
    title: 'Real-Time Radio',
    body: 'Push-to-talk like a pro. Hear your crew, hands-free.',
  },
  {
    emoji: '🗺️',
    title: 'Smart Navigation',
    body: 'Shared routes, waypoints, and hazard alerts — automatically.',
  },
  {
    emoji: '🏁',
    title: "You're ready",
    body: 'Start your first convoy in seconds.',
  },
];

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
  const { reduceMotion } = useAccessibilitySettings();

  const [currentSlide, setCurrentSlide] = useState(0);

  // Per-slide translateX: slide 0 starts visible (0), rest start off-screen right (SCREEN_WIDTH)
  const slideAnims = useRef(
    SLIDES.map((_, i) => new Animated.Value(i === 0 ? 0 : SCREEN_WIDTH)),
  ).current;

  // Dot width animations: active = 24, inactive = 8
  const dotWidths = useRef(
    SLIDES.map((_, i) => new Animated.Value(i === 0 ? 24 : 8)),
  ).current;

  // Animate dot widths whenever the active slide changes
  useEffect(() => {
    SLIDES.forEach((_, i) => {
      Animated.timing(dotWidths[i], {
        toValue: i === currentSlide ? 24 : 8,
        duration: 220,
        useNativeDriver: false,
      }).start();
    });
  }, [currentSlide, dotWidths]);

  const goToSlide = (nextIndex: number) => {
    if (reduceMotion) {
      slideAnims[currentSlide].setValue(-SCREEN_WIDTH);
      slideAnims[nextIndex].setValue(0);
      setCurrentSlide(nextIndex);
      return;
    }

    // Animate current slide out to the left; next slide in from the right
    Animated.parallel([
      Animated.spring(slideAnims[currentSlide], {
        toValue: -SCREEN_WIDTH,
        tension: 80,
        friction: 10,
        useNativeDriver: true,
      }),
      Animated.spring(slideAnims[nextIndex], {
        toValue: 0,
        tension: 80,
        friction: 10,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setCurrentSlide(nextIndex);
    });
  };

  const handleNext = () => {
    if (currentSlide < SLIDES.length - 1) {
      goToSlide(currentSlide + 1);
    } else {
      router.push('/(auth)/phone');
    }
  };

  const handleSkip = () => {
    router.push('/(auth)/phone');
  };

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

  const isLastSlide = currentSlide === SLIDES.length - 1;

  return (
    <SafeAreaView style={styles.container}>
      {/* Top bar — Skip button visible on slides 1–3 only */}
      <View style={styles.topBar}>
        {!isLastSlide && (
          <TouchableOpacity
            style={styles.skipButton}
            onPress={handleSkip}
            accessibilityRole="button"
            accessibilityLabel="Skip onboarding"
            hitSlop={theme.hitSlop}
          >
            <Text style={styles.skipText}>Skip</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Slide stack — absolutely positioned per slide, driven by translateX */}
      <View style={styles.slidesContainer}>
        {SLIDES.map((slide, i) => (
          <Animated.View
            key={i}
            style={[styles.slide, { transform: [{ translateX: slideAnims[i] }] }]}
            accessibilityElementsHidden={i !== currentSlide}
            importantForAccessibility={i !== currentSlide ? 'no-hide-descendants' : 'yes'}
          >
            {/* Large background watermark emoji (opacity 0.06) */}
            <Text style={styles.watermarkEmoji} accessibilityElementsHidden={true}>
              {slide.emoji}
            </Text>

            {/* Foreground card content */}
            <View style={styles.slideContent}>
              {/* Subtle crimson radial glow behind the emoji */}
              <View style={styles.glowOrb} pointerEvents="none" />

              <View style={styles.emojiWrapper}>
                <Text style={styles.emojiText}>{slide.emoji}</Text>
              </View>

              <Text style={styles.slideTitle}>{slide.title}</Text>
              <Text style={styles.slideBody}>{slide.body}</Text>
            </View>
          </Animated.View>
        ))}
      </View>

      {/* Progress dots — 4 dots, active = crimson pill (24×8), inactive = #444 circle (8×8) */}
      <View style={styles.dotsRow} accessibilityRole="tablist" accessibilityLabel="Slide indicators">
        {SLIDES.map((_, i) => (
          <Animated.View
            key={i}
            accessible={true}
            accessibilityRole="tab"
            accessibilityLabel={`Slide ${i + 1} of ${SLIDES.length}${i === currentSlide ? ', selected' : ''}`}
            accessibilityState={{ selected: i === currentSlide }}
            style={[
              styles.dot,
              i === currentSlide ? styles.dotActive : styles.dotInactive,
              { width: dotWidths[i] },
            ]}
          />
        ))}
      </View>

      {/* CTA section */}
      <View style={styles.ctaSection}>
        {/* Primary button: "Next →" on slides 1–3, "Let's Go →" on slide 4 */}
        <TouchableOpacity
          style={styles.ctaButton}
          onPress={handleNext}
          accessibilityRole="button"
          accessibilityLabel={isLastSlide ? "Let's Go" : 'Next slide'}
          accessibilityHint={isLastSlide ? 'Opens phone number entry screen' : 'Advances to the next slide'}
        >
          <Text style={styles.ctaText}>{isLastSlide ? "Let's Go →" : 'Next →'}</Text>
        </TouchableOpacity>

        {/* On the last slide, surface the full sign-in / social auth options */}
        {isLastSlide && (
          <>
            <View style={styles.signInRow}>
              <Text style={styles.signInHint}>Already have an account? </Text>
              <TouchableOpacity
                onPress={() => router.push('/(auth)/email')}
                accessibilityRole="button"
                accessibilityLabel="Sign In"
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
              >
                <Text style={styles.signInLink}>Sign In</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or</Text>
              <View style={styles.dividerLine} />
            </View>

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

            <TouchableOpacity
              style={[styles.googleButton, Platform.OS === 'ios' && styles.googleButtonAfterApple]}
              onPress={() => { void handleGoogleSignIn(); }}
              accessibilityRole="button"
              accessibilityLabel="Sign in with Google"
              accessibilityHint="Signs you in with your Google account"
            >
              <Text style={styles.googleButtonText}>G  Sign in with Google</Text>
            </TouchableOpacity>

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
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg,
  },

  // ── Top bar ─────────────────────────────────────────────────────────────────
  topBar: {
    height: 48,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.lg,
  },
  skipButton: {
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  skipText: {
    color: theme.colors.textMuted,
    fontSize: 15,
    fontWeight: '500',
  },

  // ── Slide stack ─────────────────────────────────────────────────────────────
  slidesContainer: {
    flex: 1,
    overflow: 'hidden',
    position: 'relative',
  },
  slide: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: SCREEN_WIDTH,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.xl,
  },
  // Giant background watermark — centered, very faint
  watermarkEmoji: {
    position: 'absolute',
    fontSize: 200,
    opacity: 0.06,
    textAlign: 'center',
  },
  slideContent: {
    alignItems: 'center',
    gap: theme.spacing.md,
    zIndex: 1,
  },
  // Crimson radial glow behind the foreground emoji
  glowOrb: {
    position: 'absolute',
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: theme.colors.accent,
    opacity: 0.1,
    top: -80,
  },
  emojiWrapper: {
    shadowColor: theme.colors.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.45,
    shadowRadius: 14,
    elevation: 10,
  },
  emojiText: {
    fontSize: 72,
    textAlign: 'center',
  },
  slideTitle: {
    fontSize: 30,
    fontWeight: '800',
    color: theme.colors.text,
    textAlign: 'center',
    letterSpacing: 0.4,
    marginTop: theme.spacing.sm,
  },
  slideBody: {
    fontSize: 16,
    color: theme.colors.textMuted,
    textAlign: 'center',
    lineHeight: 24,
  },

  // ── Progress dots ────────────────────────────────────────────────────────────
  dotsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    paddingVertical: theme.spacing.lg,
  },
  dot: {
    height: 8,
    borderRadius: 4,
  },
  dotActive: {
    backgroundColor: theme.colors.accent,   // crimson #DC143C
  },
  dotInactive: {
    backgroundColor: '#444444',
  },

  // ── CTA section ─────────────────────────────────────────────────────────────
  ctaSection: {
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.lg,
  },
  // Crimson pill button — "Next →" / "Let's Go →"
  ctaButton: {
    backgroundColor: theme.colors.accent,
    borderRadius: 28,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: theme.colors.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 6,
  },
  ctaText: {
    color: theme.colors.text,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  // ── Last-slide extras (sign-in row + social auth + legal) ───────────────────
  signInRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 14,
  },
  signInHint: {
    color: theme.colors.textMuted,
    fontSize: 14,
  },
  signInLink: {
    color: theme.colors.accent,
    fontSize: 14,
    fontWeight: '600',
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
  appleButton: {
    backgroundColor: '#000000',
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: theme.spacing.lg,
    alignItems: 'center',
    minHeight: 56,
    justifyContent: 'center',
    marginBottom: 10,
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
  },
  googleButtonAfterApple: {
    // appleButton already has marginBottom: 10 — no extra needed
  },
  googleButtonText: {
    color: '#4285F4',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  legalSection: {
    alignItems: 'center',
    paddingTop: theme.spacing.md,
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
