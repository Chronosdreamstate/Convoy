import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Linking,
} from 'react-native';
import { useRouter } from 'expo-router';

const PRIVACY_POLICY_URL = 'https://convoy.app/privacy';
const TERMS_URL = 'https://convoy.app/terms';

export default function WelcomeScreen() {
  const router = useRouter();

  const handleOpenUrl = (url: string) => {
    Linking.openURL(url).catch(() => {
      // Silently fail — URL opening errors should not crash the app
    });
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.heroSection}>
        <Text style={styles.appName}>CONVOY</Text>
        <Text style={styles.tagline}>Drive together</Text>
      </View>

      <View style={styles.buttonSection}>
        {/* Phone auth */}
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => router.push('/auth/phone')}
          accessibilityRole="button"
          accessibilityLabel="Sign in with Phone"
        >
          <Text style={styles.primaryButtonText}>Sign in with Phone</Text>
        </TouchableOpacity>

        {/* Email auth */}
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => router.push('/auth/email')}
          accessibilityRole="button"
          accessibilityLabel="Sign in with Email"
        >
          <Text style={styles.secondaryButtonText}>Sign in with Email</Text>
        </TouchableOpacity>

        {/* Sign in with Apple — always shown when other auth options are present (Req 36.1) */}
        <TouchableOpacity
          style={[styles.secondaryButton, styles.appleButton]}
          onPress={() => router.push('/auth/apple')}
          accessibilityRole="button"
          accessibilityLabel="Sign in with Apple"
        >
          <Text style={[styles.secondaryButtonText, styles.appleButtonText]}>
            {'\u{F8FF}'} Sign in with Apple
          </Text>
        </TouchableOpacity>

        {/* Sign in with Google */}
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => router.push('/auth/google')}
          accessibilityRole="button"
          accessibilityLabel="Sign in with Google"
        >
          <Text style={styles.secondaryButtonText}>Sign in with Google</Text>
        </TouchableOpacity>
      </View>

      {/* Privacy Policy and Terms of Service links (Req 36.2) */}
      <View style={styles.legalSection}>
        <Text style={styles.legalText}>By continuing, you agree to our </Text>
        <View style={styles.legalLinks}>
          <TouchableOpacity
            onPress={() => handleOpenUrl(TERMS_URL)}
            accessibilityRole="link"
            accessibilityLabel="Terms of Service"
          >
            <Text style={styles.legalLink}>Terms of Service</Text>
          </TouchableOpacity>
          <Text style={styles.legalText}> and </Text>
          <TouchableOpacity
            onPress={() => handleOpenUrl(PRIVACY_POLICY_URL)}
            accessibilityRole="link"
            accessibilityLabel="Privacy Policy"
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
    backgroundColor: '#0A0A0A',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  heroSection: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  appName: {
    fontSize: 56,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: 8,
  },
  tagline: {
    fontSize: 16,
    color: '#888888',
    marginTop: 8,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  buttonSection: {
    gap: 12,
  },
  primaryButton: {
    backgroundColor: '#FF6B00',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryButton: {
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  secondaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  appleButton: {
    backgroundColor: '#FFFFFF',
  },
  appleButtonText: {
    color: '#000000',
  },
  legalSection: {
    alignItems: 'center',
    paddingTop: 24,
  },
  legalLinks: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  legalText: {
    color: '#666666',
    fontSize: 13,
  },
  legalLink: {
    color: '#FF6B00',
    fontSize: 13,
    textDecorationLine: 'underline',
  },
});
