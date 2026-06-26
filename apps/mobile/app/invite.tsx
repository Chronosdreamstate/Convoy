import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  ActivityIndicator,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { apiClient } from '../src/services/apiClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UserProfile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  pttCallsign: string | null;
}

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; profile: UserProfile }
  | { kind: 'sent' }
  | { kind: 'already_friends' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

function Avatar({ name, size = 80 }: { name: string; size?: number }) {
  return (
    <View style={[styles.avatarRing, { width: size + 8, height: size + 8, borderRadius: (size + 8) / 2 }]}>
      <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
        <Text style={[styles.avatarText, { fontSize: size * 0.32 }]}>
          {initials(name)}
        </Text>
      </View>
    </View>
  );
}

function CallsignBadge({ callsign }: { callsign: string | null }) {
  if (callsign) {
    return (
      <View style={styles.callsignBadge}>
        <Text style={styles.callsignBadgeText}>📻 {callsign}</Text>
      </View>
    );
  }
  return (
    <View style={[styles.callsignBadge, styles.callsignBadgeMuted]}>
      <Text style={styles.callsignBadgeTextMuted}>No callsign</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function InviteScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const router = useRouter();
  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  const [sending, setSending] = useState(false);

  const cardAnim = useRef(new Animated.Value(0)).current;
  const cardTranslate = useRef(new Animated.Value(60)).current;

  const animateIn = useCallback(() => {
    Animated.parallel([
      Animated.timing(cardAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.timing(cardTranslate, { toValue: 0, duration: 500, useNativeDriver: true }),
    ]).start();
  }, [cardAnim, cardTranslate]);

  const loadProfile = useCallback(async () => {
    if (!userId) {
      setState({ kind: 'error', message: 'Invalid invite link — no user ID found.' });
      return;
    }

    setState({ kind: 'loading' });
    try {
      const res = await apiClient.get<UserProfile>(`/api/v1/users/${userId}`);
      setState({ kind: 'ready', profile: res.data });
      animateIn();
    } catch (err: unknown) {
      const status =
        err != null &&
        typeof err === 'object' &&
        'response' in err &&
        err.response != null &&
        typeof err.response === 'object' &&
        'status' in err.response
          ? (err.response as { status: number }).status
          : 0;

      if (status === 404) {
        setState({ kind: 'error', message: 'This invite link is no longer valid.' });
      } else {
        setState({ kind: 'error', message: 'Could not load profile. Please try again.' });
      }
      animateIn();
    }
  }, [userId, animateIn]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const handleSendRequest = async () => {
    if (!userId) return;
    setSending(true);
    try {
      await apiClient.post('/api/v1/friends/requests', { addresseeId: userId });
      setState({ kind: 'sent' });
    } catch (err: unknown) {
      const status =
        err != null &&
        typeof err === 'object' &&
        'response' in err &&
        err.response != null &&
        typeof err.response === 'object' &&
        'status' in err.response
          ? (err.response as { status: number }).status
          : 0;

      if (status === 409) {
        setState({ kind: 'already_friends' });
      } else if (state.kind === 'ready') {
        setState({ kind: 'error', message: 'Failed to send friend request. Please try again.' });
      }
    } finally {
      setSending(false);
    }
  };

  // ---- Render ----

  if (state.kind === 'loading') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <ActivityIndicator color="#DC143C" size="large" />
        </View>
        <Text style={styles.watermark}>CONVOY</Text>
      </SafeAreaView>
    );
  }

  if (state.kind === 'error') {
    return (
      <SafeAreaView style={styles.container}>
        <Animated.View style={[styles.centered, { opacity: cardAnim, transform: [{ translateY: cardTranslate }] }]}>
          <View style={[styles.stateIconCircle, styles.stateIconError]}>
            <Text style={styles.stateIconEmoji}>❌</Text>
          </View>
          <Text style={styles.errorTitle}>Invite Unavailable</Text>
          <Text style={styles.errorSubtitle}>{state.message}</Text>
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={() => router.replace('/(tabs)/convoy')}
            accessibilityRole="button"
            accessibilityLabel="Go to convoy"
          >
            <Text style={styles.secondaryBtnText}>Go to CONVOY</Text>
          </TouchableOpacity>
        </Animated.View>
        <Text style={styles.watermark}>CONVOY</Text>
      </SafeAreaView>
    );
  }

  if (state.kind === 'sent') {
    return (
      <SafeAreaView style={styles.container}>
        <Animated.View style={[styles.centered, { opacity: cardAnim, transform: [{ translateY: cardTranslate }] }]}>
          <View style={[styles.stateIconCircle, styles.stateIconSuccess]}>
            <Text style={styles.stateIconEmoji}>✅</Text>
          </View>
          <Text style={styles.successTitle}>Request Sent!</Text>
          <Text style={styles.successSubtitle}>
            Your friend request is on its way.
          </Text>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => router.replace('/friends')}
            accessibilityRole="button"
            accessibilityLabel="View friends"
          >
            <Text style={styles.primaryBtnText}>View Friends</Text>
          </TouchableOpacity>
        </Animated.View>
        <Text style={styles.watermark}>CONVOY</Text>
      </SafeAreaView>
    );
  }

  if (state.kind === 'already_friends') {
    return (
      <SafeAreaView style={styles.container}>
        <Animated.View style={[styles.centered, { opacity: cardAnim, transform: [{ translateY: cardTranslate }] }]}>
          <View style={[styles.stateIconCircle, styles.stateIconSuccess]}>
            <Text style={styles.stateIconEmoji}>✅</Text>
          </View>
          <Text style={styles.successTitle}>Already Connected</Text>
          <Text style={styles.successSubtitle}>
            You're already friends or a request is pending.
          </Text>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => router.replace('/friends')}
            accessibilityRole="button"
            accessibilityLabel="View friends"
          >
            <Text style={styles.primaryBtnText}>View Friends</Text>
          </TouchableOpacity>
        </Animated.View>
        <Text style={styles.watermark}>CONVOY</Text>
      </SafeAreaView>
    );
  }

  // state.kind === 'ready'
  const { profile } = state;

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          style={styles.backBtn}
        >
          <Text style={styles.backBtnText}>‹ Back</Text>
        </TouchableOpacity>
      </View>

      {/* Animated profile card */}
      <Animated.View
        style={[
          styles.card,
          { opacity: cardAnim, transform: [{ translateY: cardTranslate }] },
        ]}
      >
        <Avatar name={profile.displayName} size={80} />

        <Text style={styles.displayName} numberOfLines={1}>
          {profile.displayName}
        </Text>

        <CallsignBadge callsign={profile.pttCallsign} />

        <Text style={styles.inviteHint}>
          🚗 {profile.displayName} wants to ride with you on CONVOY
        </Text>

        <TouchableOpacity
          style={[styles.primaryBtn, styles.sendBtn]}
          onPress={() => { void handleSendRequest(); }}
          disabled={sending}
          accessibilityRole="button"
          accessibilityLabel={`Send friend request to ${profile.displayName}`}
        >
          {sending ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.primaryBtnText}>Send Friend Request</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.secondaryBtn}
          onPress={() => router.replace('/(tabs)/convoy')}
          accessibilityRole="button"
          accessibilityLabel="Dismiss and go to convoy"
        >
          <Text style={styles.secondaryBtnText}>Not Now</Text>
        </TouchableOpacity>
      </Animated.View>

      <Text style={styles.watermark}>CONVOY</Text>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },

  // Header
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  backBtn: {
    paddingVertical: 8,
    paddingHorizontal: 4,
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
  },
  backBtnText: {
    color: '#DC143C',
    fontSize: 17,
    fontWeight: '500',
  },

  // Profile card
  card: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingBottom: 48,
  },

  // Avatar with crimson ring
  avatarRing: {
    borderWidth: 2,
    borderColor: '#DC143C',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  avatar: {
    backgroundColor: '#DC143C',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#fff',
    fontWeight: '700',
  },

  displayName: {
    fontSize: 24,
    fontWeight: '700',
    color: '#F0F0F0',
    marginBottom: 10,
    textAlign: 'center',
  },

  // Callsign badge
  callsignBadge: {
    backgroundColor: '#1C1C1C',
    borderWidth: 1,
    borderColor: '#DC143C',
    borderRadius: 100,
    paddingVertical: 4,
    paddingHorizontal: 14,
    marginBottom: 20,
  },
  callsignBadgeText: {
    color: '#DC143C',
    fontSize: 13,
    fontWeight: '600',
  },
  callsignBadgeMuted: {
    borderColor: '#2A2A2A',
  },
  callsignBadgeTextMuted: {
    color: '#555555',
    fontSize: 13,
    fontWeight: '500',
  },

  inviteHint: {
    fontSize: 15,
    color: '#888888',
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 22,
  },

  // State icons (success / error)
  stateIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  stateIconSuccess: {
    backgroundColor: '#003A10',
  },
  stateIconError: {
    backgroundColor: '#3A0000',
  },
  stateIconEmoji: {
    fontSize: 30,
  },

  // Buttons
  primaryBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 12,
    paddingHorizontal: 32,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    minWidth: 220,
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  sendBtn: {
    width: '100%',
    marginBottom: 12,
  },
  secondaryBtn: {
    borderRadius: 12,
    paddingHorizontal: 32,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    minWidth: 220,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    marginTop: 4,
  },
  secondaryBtnText: {
    color: '#888888',
    fontSize: 15,
    fontWeight: '600',
  },

  // Titles
  errorTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#F0F0F0',
    marginBottom: 8,
    textAlign: 'center',
  },
  errorSubtitle: {
    fontSize: 14,
    color: '#888888',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 32,
  },
  successTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#F0F0F0',
    marginBottom: 8,
    textAlign: 'center',
  },
  successSubtitle: {
    fontSize: 14,
    color: '#888888',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 32,
  },

  // Watermark
  watermark: {
    textAlign: 'center',
    color: '#1C1C1C',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 6,
    paddingBottom: 16,
  },
});
