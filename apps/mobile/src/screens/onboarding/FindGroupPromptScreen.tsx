import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Animated,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../stores/authStore';
import { onboardingState } from '../../utils/onboardingState';
import { useTheme } from '../../theme';

export default function FindGroupPromptScreen() {
  const router = useRouter();
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const setIsFirstLogin = useAuthStore((s) => s.setIsFirstLogin);

  const card1Translate = useRef(new Animated.Value(60)).current;
  const card2Translate = useRef(new Animated.Value(60)).current;
  const card1Opacity = useRef(new Animated.Value(0)).current;
  const card2Opacity = useRef(new Animated.Value(0)).current;
  const headerOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.timing(headerOpacity, { toValue: 1, duration: 400, useNativeDriver: true }),
      Animated.stagger(120, [
        Animated.parallel([
          Animated.spring(card1Translate, { toValue: 0, useNativeDriver: true, tension: 80, friction: 9 }),
          Animated.timing(card1Opacity, { toValue: 1, duration: 300, useNativeDriver: true }),
        ]),
        Animated.parallel([
          Animated.spring(card2Translate, { toValue: 0, useNativeDriver: true, tension: 80, friction: 9 }),
          Animated.timing(card2Opacity, { toValue: 1, duration: 300, useNativeDriver: true }),
        ]),
      ]),
    ]).start();
  }, []);

  const completeOnboarding = useCallback(async (destination: string, skipped = false) => {
    await SecureStore.setItemAsync('onboarding_complete', '1').catch(() => {});
    if (skipped) {
      await onboardingState.markSkipped('group');
    } else {
      await onboardingState.markComplete('group');
    }
    setIsFirstLogin(false);
    router.replace(destination as never);
  }, [router, setIsFirstLogin]);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <Animated.View style={[styles.header, { opacity: headerOpacity }]}>
          {/* Decorative hero illustration */}
          <Text style={styles.emoji}>🏁</Text>
          <Text style={styles.heading}>Find your convoy</Text>
          <Text style={styles.body}>Connect with car enthusiasts in your area</Text>
        </Animated.View>

        <View style={styles.cardRow}>
          <Animated.View style={[styles.cardWrap, { opacity: card1Opacity, transform: [{ translateY: card1Translate }] }]}>
            <TouchableOpacity
              style={styles.card}
              onPress={() => void completeOnboarding('/group-browse')}
              activeOpacity={0.8}
              accessibilityRole="button"
            >
              <View style={styles.cardIconCircle}>
                <View style={styles.cardIconHalo} pointerEvents="none" />
                <Ionicons name="search" size={24} color={theme.colors.accent} />
              </View>
              <Text style={styles.cardTitle}>Browse Groups</Text>
              <Text style={styles.cardSub}>See what's driving near you</Text>
            </TouchableOpacity>
          </Animated.View>

          <Animated.View style={[styles.cardWrap, { opacity: card2Opacity, transform: [{ translateY: card2Translate }] }]}>
            <TouchableOpacity
              style={styles.card}
              onPress={() => void completeOnboarding('/join')}
              activeOpacity={0.8}
              accessibilityRole="button"
            >
              <View style={styles.cardIconCircle}>
                <View style={styles.cardIconHalo} pointerEvents="none" />
                <Ionicons name="key" size={24} color={theme.colors.accent} />
              </View>
              <Text style={styles.cardTitle}>Enter Code</Text>
              <Text style={styles.cardSub}>Got an invite? Enter the 6-character code</Text>
            </TouchableOpacity>
          </Animated.View>
        </View>

        <TouchableOpacity
          onPress={() => void completeOnboarding('/(tabs)/map', true)}
          hitSlop={{ top: 12, bottom: 12, left: 24, right: 24 }}
        >
          <Text style={styles.skipText}>Skip for now</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: theme.colors.bg },
    container: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 24,
      gap: 28,
    },
    header: { alignItems: 'center', gap: 10 },
    emoji: { fontSize: 52 },
    heading: {
      fontSize: 28,
      fontWeight: '800',
      color: theme.colors.text,
      textAlign: 'center',
      letterSpacing: 0.3,
    },
    body: {
      fontSize: 15,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: 21,
    },
    cardRow: {
      flexDirection: 'row',
      gap: 12,
      width: '100%',
    },
    cardWrap: { flex: 1 },
    card: {
      flex: 1,
      backgroundColor: theme.colors.card,
      borderRadius: 20,
      padding: 20,
      alignItems: 'center',
      gap: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    cardIconCircle: {
      width: 52,
      height: 52,
      borderRadius: 26,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    // Soft accent-tinted halo behind the icon — a translucent layer (rather
    // than a flat theme color) so it reads as a subtle glow at 12% opacity
    // instead of a solid muted disc.
    cardIconHalo: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: theme.colors.accent,
      opacity: 0.12,
    },
    cardTitle: { fontSize: 15, fontWeight: '700', color: theme.colors.text, textAlign: 'center' },
    cardSub: { fontSize: 12, color: theme.colors.textMuted, textAlign: 'center', lineHeight: 17 },
    skipText: { fontSize: 13, color: theme.colors.textSubtle },
  });
}
