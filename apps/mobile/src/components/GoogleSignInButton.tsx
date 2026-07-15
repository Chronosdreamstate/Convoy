import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  StyleProp,
  StyleSheet,
  Text,
  TouchableOpacity,
  ViewStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { authService } from '../services/AuthService';
import { useAuthStore } from '../stores/authStore';
import { useTheme } from '../theme';

// Google's brand blue — used for the icon, label, and border regardless of
// app theme (intentionally not themed, same convention as the Apple button).
const GOOGLE_BLUE = '#4285F4';

/**
 * When the auth API rejected us with an explanation (AuthService throws
 * ApiError: an Error carrying the HTTP status and the server's message, e.g.
 * the 503 PROVIDER_NOT_CONFIGURED gate or a 429 rate limit), surface that
 * explanation instead of a generic failure line. Structural check rather than
 * instanceof so tests that mock AuthService still match.
 */
function serverErrorMessage(err: unknown): string | null {
  if (
    err instanceof Error &&
    typeof (err as { status?: unknown }).status === 'number' &&
    err.message &&
    err.message !== 'Request failed'
  ) {
    return err.message;
  }
  return null;
}

interface GoogleSignInButtonProps {
  /** Externally disable the button (e.g. while another auth request is pending). */
  disabled?: boolean;
  /** Reports the in-flight state so parents can dim/disable sibling auth buttons. */
  onLoadingChange?: (isSigningIn: boolean) => void;
  /** Optional layout override for the slot the button sits in. */
  style?: StyleProp<ViewStyle>;
}

/**
 * OAuth client IDs for the native Google sign-in flow. Resolved at render
 * time (not module load) so tests can vary process.env per case; in app
 * builds babel-preset-expo resolves EXPO_PUBLIC_ reads statically anyway.
 */
function getGoogleClientIds() {
  return {
    iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || undefined,
    androidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID || undefined,
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || undefined,
  };
}

/**
 * Shared "Sign in with Google" button (Requirement 2.4). Renders on both
 * platforms wherever alternative auth is offered (Guideline 4.8 parity with
 * the Apple button). Owns the full Google auth flow: expo-auth-session
 * browser prompt → authService.signInWithGoogle(idToken) → auth store update
 * → navigation to the map.
 *
 * Config-gated: the native flow needs the platform's own OAuth client ID
 * (Google rejects web client IDs on custom-scheme redirects). When it is not
 * configured, the button degrades to the previous platform-aware
 * "Coming Soon" behaviour instead of crashing.
 */
export default function GoogleSignInButton(props: GoogleSignInButtonProps) {
  const clientIds = getGoogleClientIds();
  const isConfigured =
    Platform.OS === 'ios'
      ? Boolean(clientIds.iosClientId)
      : Platform.OS === 'android'
        ? Boolean(clientIds.androidClientId)
        : Boolean(clientIds.webClientId);

  if (!isConfigured) return <ComingSoonGoogleButton {...props} />;
  return <LiveGoogleSignInButton {...props} clientIds={clientIds} />;
}

/**
 * The real sign-in flow. Split into its own component so the
 * expo-auth-session hook (and its native module) is only loaded when Google
 * sign-in is actually configured — unconfigured builds never touch it.
 */
function LiveGoogleSignInButton({
  disabled = false,
  onLoadingChange,
  style,
  clientIds,
}: GoogleSignInButtonProps & { clientIds: ReturnType<typeof getGoogleClientIds> }) {
  const router = useRouter();
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { setUser, setAccessToken } = useAuthStore();
  const [isSigningIn, setIsSigningIn] = useState(false);

  // Lazy require, mirroring AppleSignInButton's expo-apple-authentication
  // pattern — keeps the module out of environments that never render this.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Google = require('expo-auth-session/providers/google') as typeof import('expo-auth-session/providers/google');
  const [request, , promptAsync] = Google.useIdTokenAuthRequest({
    iosClientId: clientIds.iosClientId,
    androidClientId: clientIds.androidClientId,
    webClientId: clientIds.webClientId,
  });

  const updateSigningIn = (value: boolean) => {
    setIsSigningIn(value);
    onLoadingChange?.(value);
  };

  const handleGoogleSignIn = async () => {
    if (isSigningIn || disabled || !request) return;
    updateSigningIn(true);
    try {
      const result = await promptAsync();
      if (result.type === 'success') {
        const idToken = (result.params as { id_token?: string }).id_token;
        if (idToken) {
          const auth = await authService.signInWithGoogle(idToken);
          setUser(auth.user);
          setAccessToken(auth.accessToken);
          // Shared post-auth routing (with OtpScreen/EmailScreen): new users
          // resume onboarding, returning users go to the map.
          const { route, isFirstLogin } = await authService.getPostAuthRoute();
          useAuthStore.getState().setIsFirstLogin(isFirstLogin);
          router.replace(route as never);
        } else {
          // Google reported success but returned no ID token — previously this
          // failed silently, leaving the user staring at an idle button.
          Alert.alert('Sign In Failed', 'Could not sign in with Google. Please try another method.');
        }
      } else if (result.type === 'error') {
        Alert.alert('Sign In Failed', 'Could not sign in with Google. Please try another method.');
      }
      // 'cancel' / 'dismiss' — the user backed out of the browser prompt;
      // stay silent, same as a cancelled Apple credential prompt.
    } catch (err: unknown) {
      Alert.alert(
        'Sign In Failed',
        serverErrorMessage(err) ?? 'Could not sign in with Google. Please try another method.',
      );
    } finally {
      updateSigningIn(false);
    }
  };

  const isDisabled = isSigningIn || disabled || !request;

  return (
    <TouchableOpacity
      testID="google-sign-in-button"
      style={[styles.googleButton, isDisabled && styles.googleButtonDisabled, style]}
      onPress={() => { void handleGoogleSignIn(); }}
      disabled={isDisabled}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel="Sign in with Google"
      accessibilityHint="Signs you in with your Google account"
      accessibilityState={{ disabled: isDisabled, busy: isSigningIn }}
    >
      {isSigningIn ? (
        <ActivityIndicator color={GOOGLE_BLUE} />
      ) : (
        <>
          <Ionicons name="logo-google" size={18} color={GOOGLE_BLUE} />
          <Text style={styles.googleButtonText}>Sign in with Google</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

/**
 * Graceful degradation when no Google OAuth client ID is configured for this
 * platform — the previous "Coming Soon" stub, preserved verbatim.
 */
function ComingSoonGoogleButton({ disabled = false, style }: GoogleSignInButtonProps) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const handlePress = () => {
    // Apple Sign-In only exists on iOS — don't suggest it on Android.
    Alert.alert(
      'Coming Soon',
      Platform.OS === 'ios'
        ? 'Google Sign-In will be available in a future update. Please use phone, email, or Apple Sign-In.'
        : 'Google Sign-In will be available in a future update. Please use phone or email sign-in.',
    );
  };

  return (
    <TouchableOpacity
      testID="google-sign-in-button"
      style={[styles.googleButton, disabled && styles.googleButtonDisabled, style]}
      onPress={handlePress}
      disabled={disabled}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel="Sign in with Google"
      accessibilityHint="Signs you in with your Google account"
      accessibilityState={{ disabled }}
    >
      <Ionicons name="logo-google" size={18} color={GOOGLE_BLUE} />
      <Text style={styles.googleButtonText}>Sign in with Google</Text>
    </TouchableOpacity>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    googleButton: {
      flexDirection: 'row',
      backgroundColor: theme.colors.card,
      borderRadius: 14,
      paddingVertical: 18,
      paddingHorizontal: theme.spacing.lg,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      minHeight: 56,
      borderWidth: 1,
      // Google's brand blue border — intentionally not themed, see appleButton.
      borderColor: GOOGLE_BLUE,
    },
    googleButtonDisabled: { opacity: 0.5 },
    googleButtonText: {
      color: GOOGLE_BLUE,
      fontSize: 16,
      fontWeight: '600',
      letterSpacing: 0.3,
    },
  });
}
