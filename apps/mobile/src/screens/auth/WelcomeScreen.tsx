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
  ScrollView,
  Dimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { authService } from '../../services/AuthService';
import { useAuthStore } from '../../stores/authStore';
import { theme } from '../../theme';
import { GoogleSignin } from '@react-native-google-signin/google-signin';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const SLIDES = [
  {
    emoji: '🏎️',
    title: 'Drive Together',
    body: 'Real-time tracking keeps your whole crew connected on the road',
    animated: true,
  },
  {
    emoji: '🎙️',
    title: 'Built-in Radio',
    body: 'Push-to-talk radio. No phones needed. One button, instant voice.',
    animated: false,
  },
  {
    emoji: '🏁',
    title: 'Your Community',
    body: 'Find car meets, group drives, and events near you',
    animated: false,
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

  // Hero fade-in + slide-up on mount
  const heroOpacity = useRef(new Animated.Value(0)).current;
  const heroTranslate = useRef(new Animated.Value(30)).current;

  // Accent pulse loop
  const accentScale = useRef(new Animated.Value(1)).current;

  // Animated car for slide 1
  const carTranslate = useRef(new Animated.Value(-20)).current;

  // Carousel state
  const [activeSlide, setActiveSlide] = useState(0);
  const carouselRef = useRef<ScrollView>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeSlideRef = useRef(0);

  // Animated dot widths — spring from 6px to 20px on active
  const dotWidths = useRef(SLIDES.map((_, i) => new Animated.Value(i === 0 ? 20 : 6))).current;

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

    // Bouncing car on slide 1
    Animated.loop(
      Animated.sequence([
        Animated.spring(carTranslate, { toValue: 24, useNativeDriver: true, speed: 2, bounciness: 10 }),
        Animated.spring(carTranslate, { toValue: -20, useNativeDriver: true, speed: 2, bounciness: 10 }),
      ]),
    ).start();

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

    intervalRef.current = setInterval(() => {
      const next = (activeSlideRef.current + 1) % SLIDES.length;
      activeSlideRef.current = next;
      setActiveSlide(next);
      carouselRef.current?.scrollTo({ x: next * SCREEN_WIDTH, animated: true });
    }, 4000);

    return () => {
      pulse.stop();
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [heroOpacity, heroTranslate, accentScale]);

  // Spring-animate dot widths whenever active slide changes
  useEffect(() => {
    SLIDES.forEach((_, i) => {
      Animated.spring(dotWidths[i], {
        toValue: i === activeSlide ? 20 : 6,
        useNativeDriver: false,
        tension: 120,
        friction: 8,
      }).start();
    });
  }, [activeSlide, dotWidths]);

  const handleCarouselScroll = (e: { nativeEvent: { contentOffset: { x: number } } }) => {
    const idx = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    if (idx !== activeSlideRef.current) {
      activeSlideRef.current = idx;
      setActiveSlide(idx);
      // Reset timer on manual swipe
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(() => {
        const next = (activeSlideRef.current + 1) % SLIDES.length;
        activeSlideRef.current = next;
        setActiveSlide(next);
        carouselRef.current?.scrollTo({ x: next * SCREEN_WIDTH, animated: true });
      }, 4000);
    }
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

  return (
    <SafeAreaView style={styles.container}>
      {/* CONVOY hero wordmark */}
      <Animated.View
        style={[
          styles.heroSection,
          { opacity: heroOpacity, transform: [{ translateY: heroTranslate }] },
        ]}
        accessibilityLabel="CONVOY app logo"
        accessibilityRole="image"
      >
        <Text style={styles.appName}>CONVOY</Text>
        <Animated.View style={[styles.logoAccent, { transform: [{ scaleX: accentScale }] }]} />
      </Animated.View>

      {/* Value-prop carousel */}
      <Animated.View style={[styles.carouselWrapper, { opacity: heroOpacity }]}>
        <ScrollView
          ref={carouselRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={handleCarouselScroll}
          scrollEventThrottle={16}
          style={styles.carousel}
        >
          {SLIDES.map((slide, i) => (
            <View key={i} style={styles.slide}>
              {/* Subtle crimson corner glow */}
              <View style={styles.slideGlow} pointerEvents="none" />

              {/* Hero emoji — animated bounce on slide 1 */}
              <View style={styles.emojiWrapper}>
                {slide.animated ? (
                  <Animated.Text style={[styles.emojiText, { transform: [{ translateX: carTranslate }] }]}>
                    {slide.emoji}
                  </Animated.Text>
                ) : (
                  <Text style={styles.emojiText}>{slide.emoji}</Text>
                )}
              </View>

              <Text style={styles.slideTitle}>{slide.title}</Text>
              <Text style={styles.slideBody}>{slide.body}</Text>
            </View>
          ))}
        </ScrollView>

        {/* Animated dot indicators */}
        <View style={styles.dotsRow}>
          {SLIDES.map((_, i) => (
            <Animated.View
              key={i}
              style={[
                styles.dot,
                i === activeSlide ? styles.dotActive : styles.dotInactive,
                { width: dotWidths[i] },
              ]}
            />
          ))}
        </View>
      </Animated.View>

      {/* CTA section */}
      <View style={styles.buttonSection}>
        {/* Primary CTA */}
        <TouchableOpacity
          style={styles.getStartedButton}
          onPress={() => router.push('/(auth)/phone')}
          accessibilityRole="button"
          accessibilityLabel="Get Started"
          accessibilityHint="Opens phone number entry screen"
        >
          <Text style={styles.getStartedText}>Get Started</Text>
        </TouchableOpacity>

        {/* Already have an account link */}
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

        {/* Social auth divider */}
        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or</Text>
          <View style={styles.dividerLine} />
        </View>

        {/* Apple sign-in */}
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
          style={[styles.googleButton, Platform.OS === 'ios' && styles.googleButtonAfterApple]}
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
    paddingVertical: theme.spacing.xl,
  },
  heroSection: {
    alignItems: 'center',
    paddingTop: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
  },
  appName: {
    fontSize: 32,
    fontWeight: '900',
    color: theme.colors.text,
    letterSpacing: 6,
  },
  logoAccent: {
    width: 80,
    height: 3,
    backgroundColor: theme.colors.accent,
    borderRadius: 2,
    marginTop: theme.spacing.sm,
  },
  carouselWrapper: {
    flex: 1,
    justifyContent: 'center',
    marginTop: theme.spacing.lg,
  },
  carousel: {
    flexGrow: 0,
  },
  slide: {
    width: SCREEN_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.xl,
    gap: theme.spacing.md,
    overflow: 'hidden',
  },
  // Subtle crimson glow orb pinned to top-right of each slide
  slideGlow: {
    position: 'absolute',
    top: -80,
    right: -60,
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: theme.colors.accent,
    opacity: 0.07,
  },
  // Wrapper gives the emoji a crimson drop shadow
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
    fontSize: 28,
    fontWeight: '800',
    color: theme.colors.text,
    textAlign: 'center',
    letterSpacing: 0.5,
    marginTop: theme.spacing.sm,
  },
  slideBody: {
    fontSize: 15,
    color: theme.colors.textMuted,
    textAlign: 'center',
    lineHeight: 22,
  },
  dotsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    marginTop: theme.spacing.lg,
  },
  dot: {
    height: 6,
    borderRadius: 3,
  },
  dotActive: {
    backgroundColor: theme.colors.accent,
  },
  dotInactive: {
    backgroundColor: theme.colors.border,
  },
  buttonSection: {
    paddingBottom: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
  },
  // "Get Started" — 56px tall, pill shape (borderRadius 28), crimson with glow
  getStartedButton: {
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
  getStartedText: {
    color: theme.colors.text,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
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
    // no extra margin needed — appleButton already has marginBottom: 10
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
    paddingHorizontal: theme.spacing.lg,
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
