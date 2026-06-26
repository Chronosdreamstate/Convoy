import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Animated,
} from 'react-native';
import { useRouter } from 'expo-router';

export default function PTTTutorialScreen() {
  const router = useRouter();

  const scaleAnim = useRef(new Animated.Value(1)).current;
  const opacityAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(scaleAnim, {
            toValue: 1.3,
            duration: 1200,
            useNativeDriver: true,
          }),
          Animated.timing(scaleAnim, {
            toValue: 1,
            duration: 0,
            useNativeDriver: true,
          }),
        ]),
        Animated.sequence([
          Animated.timing(opacityAnim, {
            toValue: 0,
            duration: 1200,
            useNativeDriver: true,
          }),
          Animated.timing(opacityAnim, {
            toValue: 1,
            duration: 0,
            useNativeDriver: true,
          }),
        ]),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [scaleAnim, opacityAnim]);

  const goToFindGroup = () => {
    router.replace('/(onboarding)/find-group' as never);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <View style={styles.topSection}>
          <View style={styles.buttonWrapper}>
            {/* Animated pulsing ring */}
            <Animated.View
              style={[
                styles.pulseRing,
                {
                  transform: [{ scale: scaleAnim }],
                  opacity: opacityAnim,
                },
              ]}
            />

            {/* Mock PTT button — non-functional UI demo */}
            <View style={styles.pttButton}>
              <Text style={styles.pttIcon}>🎙️</Text>
            </View>
          </View>

          <Text style={styles.holdToTalk}>Hold to Talk</Text>
          <Text style={styles.subText}>
            {'During a convoy, press and hold the button\nto broadcast your voice to the group.'}
          </Text>
        </View>

        <View style={styles.bottomSection}>
          <TouchableOpacity
            style={styles.gotItBtn}
            onPress={goToFindGroup}
            activeOpacity={0.85}
          >
            <Text style={styles.gotItText}>Got it!</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={goToFindGroup}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Text style={styles.skipText}>Skip tutorial</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0A0A0A' },
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 48,
  },
  topSection: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
  },
  buttonWrapper: {
    width: 160,
    height: 160,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseRing: {
    position: 'absolute',
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 3,
    borderColor: '#DC143C',
  },
  pttButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#DC143C',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pttIcon: {
    fontSize: 36,
  },
  holdToTalk: {
    fontSize: 22,
    fontWeight: '700',
    color: '#FFFFFF',
    textAlign: 'center',
  },
  subText: {
    fontSize: 15,
    color: '#888888',
    textAlign: 'center',
    lineHeight: 22,
  },
  bottomSection: {
    width: '100%',
    alignItems: 'center',
    gap: 16,
  },
  gotItBtn: {
    width: '100%',
    backgroundColor: '#DC143C',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  gotItText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  skipText: {
    fontSize: 14,
    color: '#888888',
  },
});
