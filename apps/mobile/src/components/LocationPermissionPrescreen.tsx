import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme';

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
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
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
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={() => onSkip?.()}
    >
      <Animated.View style={[styles.overlay, { opacity: fadeAnim }]}>
        <SafeAreaView style={styles.safe}>
          <Animated.View style={[styles.card, { transform: [{ scale: scaleAnim }] }]}>
            {/* Pin icon */}
            <Animated.Text style={[styles.pinEmoji, { transform: [{ scale: pinPulse }] }]}>
              📍
            </Animated.Text>

            <Text style={styles.title}>CORTEGE needs your location</Text>
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
              activeOpacity={0.8}
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
                activeOpacity={0.7}
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

// Previously every color here was a hardcoded hex literal copied from the
// dark palette, so this modal ignored the user's light/dark theme preference
// (see SettingsScreen's Theme setting) — unlike every other screen in the
// onboarding/auth flow. Now themed via useTheme(), same as its siblings.
function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: theme.colors.bg,
  },
  safe: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
  },
  card: {
    width: '100%',
    alignItems: 'center',
  },
  pinEmoji: {
    fontSize: 64,
    marginBottom: theme.spacing.lg,
  },
  title: {
    color: theme.colors.text,
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
    letterSpacing: 0.2,
  },
  subtitle: {
    color: theme.colors.textMuted,
    fontSize: 15,
    textAlign: 'center',
    marginBottom: theme.spacing.xl,
    lineHeight: 22,
  },
  bullets: {
    width: '100%',
    gap: theme.spacing.md,
    marginBottom: 28,
  },
  bullet: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: theme.colors.card,
    borderRadius: theme.radius.md,
    padding: 14,
    gap: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  bulletIcon: {
    fontSize: 20,
    lineHeight: 24,
  },
  bulletText: {
    color: theme.colors.text,
    fontSize: 14,
    lineHeight: 20,
    flex: 1,
    fontWeight: '500',
  },
  privacy: {
    color: theme.colors.textSubtle,
    fontSize: 12,
    textAlign: 'center',
    marginBottom: theme.spacing.xl,
    lineHeight: 18,
    paddingHorizontal: 8,
  },
  allowBtn: {
    width: '100%',
    height: 56,
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: theme.spacing.md,
    shadowColor: theme.colors.accent,
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  allowBtnText: {
    color: theme.colors.text,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  skipBtn: {
    paddingVertical: 12,
    paddingHorizontal: theme.spacing.lg,
  },
  skipText: {
    color: theme.colors.textSubtle,
    fontSize: 14,
    fontWeight: '500',
  },
  });
}
