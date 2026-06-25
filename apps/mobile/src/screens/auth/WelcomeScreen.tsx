import React from 'react';
import {
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

  const handleOpenUrl = (url: string) => {
    Linking.openURL(url).catch(() => {});
  };

  const handleAppleSignIn = async () => {
    if (Platform.OS !== 'ios') return;
    try {
      // expo-apple-authentication must be installed: npx expo install expo-apple-authentication
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const AppleAuth = require('expo-apple-authentication');
      const credential = await AppleAuth.signInAsync({
        requestedScopes: [
          AppleAuth.AppleAuthenticationScope.FULL_NAME,
          AppleAuth.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (credential.identityToken) {
        await authService.signInSocial('apple', credential.identityToken);
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
      await authService.signInSocial('google', idToken);
      router.replace('/(tabs)/map');
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'SIGN_IN_CANCELLED' || code === '12501') return;
      Alert.alert('Sign In Failed', 'Could not sign in with Google. Please try another method.');
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.heroSection}>
        <Text style={styles.appName}>CONVOY</Text>
        {/* Orange underline accent */}
        <View style={styles.logoAccent} />
        <Text style={styles.tagline}>Drive together. Stay connected.</Text>
      </View>

      <View style={styles.buttonSection}>
        {/* Phone auth */}
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => router.push('/(auth)/phone')}
          accessibilityRole="button"
          accessibilityLabel="Sign in with Phone"
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
        >
          <Text style={styles.secondaryButtonText}>✉️  Sign in with Email</Text>
        </TouchableOpacity>

        {/* Social sign-in — Apple (iOS App Store required), Google */}
        {Platform.OS === 'ios' && (
          <TouchableOpacity
            style={styles.appleButton}
            onPress={() => { void handleAppleSignIn(); }}
            accessibilityRole="button"
            accessibilityLabel="Sign in with Apple"
          >
            <Text style={styles.appleButtonText}>Sign in with Apple</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={styles.googleButton}
          onPress={() => { void handleGoogleSignIn(); }}
          accessibilityRole="button"
          accessibilityLabel="Sign in with Google"
        >
          <Text style={styles.googleButtonText}>Sign in with Google</Text>
        </TouchableOpacity>
      </View>

      {/* Privacy Policy and Terms of Service links */}
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
    fontSize: 72,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: 10,
  },
  logoAccent: {
    width: 80,
    height: 3,
    backgroundColor: '#DC143C',
    borderRadius: 2,
    marginTop: 8,
    marginBottom: 16,
  },
  tagline: {
    fontSize: 16,
    color: '#888888',
    letterSpacing: 0.5,
    textAlign: 'center',
  },
  buttonSection: {
    paddingBottom: 8,
  },
  primaryButton: {
    backgroundColor: '#DC143C',
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 24,
    alignItems: 'center',
    minHeight: 56,
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#FFFFFF',
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
    backgroundColor: '#2A2A2A',
  },
  dividerText: {
    color: '#555555',
    fontSize: 13,
    marginHorizontal: 12,
  },
  secondaryButton: {
    backgroundColor: '#1C1C1C',
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 24,
    alignItems: 'center',
    minHeight: 56,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  secondaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  appleButton: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 24,
    alignItems: 'center',
    minHeight: 56,
    justifyContent: 'center',
    marginTop: 10,
  },
  appleButtonText: {
    color: '#000000',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  googleButton: {
    backgroundColor: '#1C1C1C',
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 24,
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
    paddingTop: 24,
  },
  legalLinks: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  legalText: {
    color: '#888888',
    fontSize: 11,
  },
  legalLink: {
    color: '#DC143C',
    fontSize: 11,
    textDecorationLine: 'underline',
  },
});
