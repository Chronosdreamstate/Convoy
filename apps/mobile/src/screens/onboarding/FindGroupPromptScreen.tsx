import React, { useCallback, useEffect, useRef } from 'react';
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
import { useAuthStore } from '../../stores/authStore';

export default function FindGroupPromptScreen() {
  const router = useRouter();
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

  const completeOnboarding = useCallback(async (destination: string) => {
    await SecureStore.setItemAsync('onboarding_complete', '1').catch(() => {});
    setIsFirstLogin(false);
    router.replace(destination as never);
  }, [router, setIsFirstLogin]);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <Animated.View style={[styles.header, { opacity: headerOpacity }]}>
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
            >
              <View style={styles.cardIconCircle}>
                <Text style={styles.cardEmoji}>🔍</Text>
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
            >
              <View style={styles.cardIconCircle}>
                <Text style={styles.cardEmoji}>🔑</Text>
              </View>
              <Text style={styles.cardTitle}>Enter Code</Text>
              <Text style={styles.cardSub}>Got an invite? Enter the 8-digit code</Text>
            </TouchableOpacity>
          </Animated.View>
        </View>

        <TouchableOpacity
          onPress={() => void completeOnboarding('/(tabs)/map')}
          hitSlop={{ top: 12, bottom: 12, left: 24, right: 24 }}
        >
          <Text style={styles.skipText}>Skip for now</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0A0A0A' },
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
    color: '#FFFFFF',
    textAlign: 'center',
    letterSpacing: 0.3,
  },
  body: {
    fontSize: 15,
    color: '#888888',
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
    backgroundColor: '#1C1C1C',
    borderRadius: 20,
    padding: 20,
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  cardIconCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(220,20,60,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardEmoji: { fontSize: 26 },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#FFFFFF', textAlign: 'center' },
  cardSub: { fontSize: 12, color: '#888888', textAlign: 'center', lineHeight: 17 },
  skipText: { fontSize: 13, color: '#555555' },
});
