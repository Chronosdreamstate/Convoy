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

// Text/icons that always sit on Apple's brand-black fill — stays light in both
// themes. In light mode theme.colors.text is near-black, which would be
// invisible on this fill (ON_ACCENT convention).
const ON_ACCENT = '#FFFFFF';

/**
 * When the auth API rejected us with an explanation (AuthService throws
 * ApiError: an Error carrying the HTTP status and the server's message, e.g.
 * a 429 rate limit or 503 provider gate), surface that explanation instead of
 * a generic failure line. Structural check rather than instanceof so tests
 * that mock AuthService still match.
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

interface AppleSignInButtonProps {
  /** Externally disable the button (e.g. while another auth request is pending). */
  disabled?: boolean;
  /** Reports the in-flight state so parents can dim/disable sibling auth buttons. */
  onLoadingChange?: (isSigningIn: boolean) => void;
  /** Optional layout override for the slot the button sits in. */
  style?: StyleProp<ViewStyle>;
}

/**
 * Shared "Sign in with Apple" button (Requirement 36.1 / App Store
 * Guideline 4.8). Renders nothing on non-iOS platforms. Owns the full Apple
 * auth flow: native credential prompt → authService.signInSocial('apple') →
 * auth store update → navigation to the map.
 */
export default function AppleSignInButton({
  disabled = false,
  onLoadingChange,
  style,
}: AppleSignInButtonProps) {
  const router = useRouter();
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { setUser, setAccessToken } = useAuthStore();
  const [isSigningIn, setIsSigningIn] = useState(false);

  if (Platform.OS !== 'ios') return null;

  const updateSigningIn = (value: boolean) => {
    setIsSigningIn(value);
    onLoadingChange?.(value);
  };

  const handleAppleSignIn = async () => {
    if (isSigningIn || disabled) return;
    updateSigningIn(true);
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
        // Shared post-auth routing (with OtpScreen/EmailScreen): new users
        // resume onboarding, returning users go to the map.
        const { route, isFirstLogin } = await authService.getPostAuthRoute();
        useAuthStore.getState().setIsFirstLogin(isFirstLogin);
        router.replace(route as never);
      }
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code !== 'ERR_REQUEST_CANCELED') {
        Alert.alert(
          'Sign In Failed',
          serverErrorMessage(err) ?? 'Could not sign in with Apple. Please try another method.',
        );
      }
    } finally {
      updateSigningIn(false);
    }
  };

  const isDisabled = isSigningIn || disabled;

  return (
    <TouchableOpacity
      testID="apple-sign-in-button"
      style={[styles.appleButton, isDisabled && styles.appleButtonDisabled, style]}
      onPress={() => { void handleAppleSignIn(); }}
      disabled={isDisabled}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel="Sign in with Apple"
      accessibilityHint="Signs you in with your Apple ID"
      accessibilityState={{ disabled: isDisabled, busy: isSigningIn }}
    >
      {isSigningIn ? (
        <ActivityIndicator color={ON_ACCENT} />
      ) : (
        <>
          <Ionicons name="logo-apple" size={20} color={ON_ACCENT} />
          <Text style={styles.appleButtonText}>Sign in with Apple</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    // Apple's Sign in with Apple button is brand-mandated to be solid black
    // with a near-black hairline border regardless of app theme — intentionally
    // not themed.
    appleButton: {
      flexDirection: 'row',
      backgroundColor: '#000000',
      borderRadius: 14,
      paddingVertical: 18,
      paddingHorizontal: theme.spacing.lg,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      minHeight: 56,
      marginBottom: 10,
      borderWidth: 1,
      borderColor: '#333333',
    },
    appleButtonDisabled: { opacity: 0.45 },
    appleButtonText: {
      color: ON_ACCENT,
      fontSize: 16,
      fontWeight: '600',
      letterSpacing: 0.3,
    },
  });
}
