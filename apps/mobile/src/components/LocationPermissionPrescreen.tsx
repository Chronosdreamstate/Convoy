import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface Props {
  visible: boolean;
  onAllow: () => void;
  onSkip?: () => void;
}

const BULLETS: { icon: string; text: string }[] = [
  { icon: '🚗', text: 'Keep your position synced with the convoy' },
  { icon: '🗺️', text: 'Find car meets happening near you' },
  { icon: '🔒', text: 'Your location is only shared with convoy members' },
];

export default function LocationPermissionPrescreen({ visible, onAllow, onSkip }: Props) {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.9)).current;
  const pinPulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }),
        Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, damping: 18, stiffness: 200 }),
      ]).start();

      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pinPulse, { toValue: 1.12, duration: 900, useNativeDriver: true }),
          Animated.timing(pinPulse, { toValue: 1, duration: 900, useNativeDriver: true }),
        ]),
      );
      pulse.start();
      return () => pulse.stop();
    } else {
      fadeAnim.setValue(0);
      scaleAnim.setValue(0.9);
    }
  }, [visible, fadeAnim, scaleAnim, pinPulse]);

  return (
    <Modal visible={visible} transparent animationType="none" statusBarTranslucent>
      <Animated.View style={[styles.overlay, { opacity: fadeAnim }]}>
        <SafeAreaView style={styles.safe}>
          <Animated.View style={[styles.card, { transform: [{ scale: scaleAnim }] }]}>
            {/* Pin icon */}
            <Animated.Text style={[styles.pinEmoji, { transform: [{ scale: pinPulse }] }]}>
              📍
            </Animated.Text>

            <Text style={styles.title}>CONVOY needs your location</Text>
            <Text style={styles.subtitle}>To keep your convoy together in real time</Text>

            {/* Bullet points */}
            <View style={styles.bullets}>
              {BULLETS.map((b) => (
                <View key={b.icon} style={styles.bullet}>
                  <Text style={styles.bulletIcon}>{b.icon}</Text>
                  <Text style={styles.bulletText}>{b.text}</Text>
                </View>
              ))}
            </View>

            {/* Privacy note */}
            <Text style={styles.privacy}>
              We never share your location outside your active convoy.
            </Text>

            {/* Allow button */}
            <TouchableOpacity
              style={styles.allowBtn}
              onPress={onAllow}
              accessibilityRole="button"
              accessibilityLabel="Allow location access"
              accessibilityHint="Opens the system location permission dialog"
            >
              <Text style={styles.allowBtnText}>Allow Location Access</Text>
            </TouchableOpacity>

            {/* Skip */}
            {onSkip && (
              <TouchableOpacity
                style={styles.skipBtn}
                onPress={onSkip}
                accessibilityRole="button"
                accessibilityLabel="Not now"
              >
                <Text style={styles.skipText}>Not now</Text>
              </TouchableOpacity>
            )}
          </Animated.View>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  safe: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    alignItems: 'center',
  },
  pinEmoji: {
    fontSize: 64,
    marginBottom: 24,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
    letterSpacing: 0.2,
  },
  subtitle: {
    color: '#888888',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 22,
  },
  bullets: {
    width: '100%',
    gap: 16,
    marginBottom: 28,
  },
  bullet: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#1C1C1C',
    borderRadius: 12,
    padding: 14,
    gap: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  bulletIcon: {
    fontSize: 20,
    lineHeight: 24,
  },
  bulletText: {
    color: '#FFFFFF',
    fontSize: 14,
    lineHeight: 20,
    flex: 1,
    fontWeight: '500',
  },
  privacy: {
    color: '#555555',
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 18,
    paddingHorizontal: 8,
  },
  allowBtn: {
    width: '100%',
    height: 56,
    backgroundColor: '#DC143C',
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    shadowColor: '#DC143C',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  allowBtnText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  skipBtn: {
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  skipText: {
    color: '#555555',
    fontSize: 14,
    fontWeight: '500',
  },
});
