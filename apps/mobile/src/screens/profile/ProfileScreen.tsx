import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import ProfileCompletionBar from '../../components/ProfileCompletionBar';
import { apiClient } from '../../services/apiClient';
import { authService } from '../../services/AuthService';
import { useAuthStore } from '../../stores/authStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Profile {
  id: string;
  displayName: string;
  phoneNumber: string | null;
  email: string | null;
  avatarUrl: string | null;
  pttCallsign: string | null;
  privacy: 'open' | 'invite_only';
}

// ---------------------------------------------------------------------------
// Avatar with initials fallback
// ---------------------------------------------------------------------------

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

function AvatarCircle({ name }: { name: string }) {
  return (
    <View style={styles.avatarRing}>
      <View style={styles.avatarCircle}>
        <Text style={styles.avatarInitials}>{initials(name)}</Text>
      </View>
    </View>
  );
}

function CallsignBadge({ callsign }: { callsign: string | null }) {
  return (
    <View style={styles.callsignBadge}>
      <Text style={[styles.callsignText, !callsign && styles.callsignMuted]}>
        {callsign ? `📻 ${callsign}` : 'No callsign'}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function ProfileScreen() {
  const router = useRouter();
  const signOut = useAuthStore((s) => s.signOut);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [vehicleCount, setVehicleCount] = useState(0);
  const [friendCount, setFriendCount] = useState(0);

  // Inline-edit state
  const [displayName, setDisplayName] = useState('');
  const [pttCallsign, setPttCallsign] = useState('');
  const [privacy, setPrivacy] = useState<'open' | 'invite_only'>('open');
  const [isDirty, setIsDirty] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const nameInputRef = useRef<import('react-native').TextInput>(null);

  // Mounted guard — prevents setState calls after the component unmounts
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    void loadProfile();
  }, []);

  const loadProfile = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiClient.get<Profile>('/api/v1/users/me');
      if (!isMounted.current) return;
      const p = res.data;
      setProfile(p);
      setDisplayName(p.displayName);
      setPttCallsign(p.pttCallsign ?? '');
      setPrivacy(p.privacy);
      setIsDirty(false);
      // Fetch vehicle + friend counts for profile completion bar
      try {
        const [vRes, fRes] = await Promise.allSettled([
          apiClient.get<{ vehicles: unknown[] }>('/api/v1/vehicles'),
          apiClient.get<{ friends: unknown[] }>('/api/v1/friends'),
        ]);
        if (vRes.status === 'fulfilled') setVehicleCount(vRes.value.data.vehicles?.length ?? 0);
        if (fRes.status === 'fulfilled') setFriendCount(fRes.value.data.friends?.length ?? 0);
      } catch { /* non-fatal */ }
    } catch {
      if (!isMounted.current) return;
      setError('Failed to load profile. Please try again.');
    } finally {
      if (isMounted.current) setIsLoading(false);
    }
  };

  const handleSaveProfile = async () => {
    const trimmed = displayName.trim();
    if (!trimmed) {
      setError('Display name cannot be empty.');
      return;
    }
    if (!isDirty) return;

    setIsSaving(true);
    setError(null);
    setSaveSuccess(false);
    try {
      const res = await apiClient.patch<Profile>('/api/v1/users/me', {
        displayName: trimmed,
        pttCallsign: pttCallsign.trim() || null,
        privacy,
      });
      if (!isMounted.current) return;
      setProfile(res.data);
      setDisplayName(res.data.displayName);
      setPttCallsign(res.data.pttCallsign ?? '');
      setPrivacy(res.data.privacy);
      setIsDirty(false);
      setSaveSuccess(true);
      // Clear the success banner after 3 seconds
      setTimeout(() => {
        if (isMounted.current) setSaveSuccess(false);
      }, 3000);
    } catch {
      if (!isMounted.current) return;
      setError('Failed to update profile.');
    } finally {
      if (isMounted.current) setIsSaving(false);
    }
  };

  const handleSignOut = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          await authService.signOut();
          router.replace('/(auth)/welcome');
        },
      },
    ]);
  };

  // Loading state
  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <ActivityIndicator color="#DC143C" size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Page title */}
        <Text style={styles.pageTitle}>Profile</Text>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {saveSuccess ? <Text style={styles.successText}>Profile saved successfully.</Text> : null}

        {/* Avatar + callsign badge */}
        <View style={styles.avatarSection}>
          <AvatarCircle name={displayName || profile?.displayName || '?'} />
          <TouchableOpacity
            style={styles.displayNameRow}
            onPress={() => {
              setEditingName(true);
              setTimeout(() => nameInputRef.current?.focus(), 50);
            }}
            accessibilityRole="button"
            accessibilityLabel="Edit display name"
          >
            {editingName ? (
              <TextInput
                ref={nameInputRef}
                style={styles.displayNameInput}
                value={displayName}
                onChangeText={(v) => { setDisplayName(v); setIsDirty(true); }}
                onBlur={() => setEditingName(false)}
                onSubmitEditing={() => setEditingName(false)}
                placeholder="Your display name"
                placeholderTextColor="#555555"
                maxLength={100}
                returnKeyType="done"
                accessibilityLabel="Display name input"
              />
            ) : (
              <Text style={styles.displayNameText} numberOfLines={1}>
                {displayName || profile?.displayName || ''}
                <Text style={styles.editPencil}>  ✏️</Text>
              </Text>
            )}
          </TouchableOpacity>
          <CallsignBadge callsign={pttCallsign || (profile?.pttCallsign ?? null)} />
          {profile?.email ? (
            <Text style={styles.accountMeta}>{profile.email}</Text>
          ) : profile?.phoneNumber ? (
            <Text style={styles.accountMeta}>{profile.phoneNumber}</Text>
          ) : null}
        </View>

        {/* Callsign + privacy card */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>PTT Callsign</Text>
          <TextInput
            style={[styles.nameInput, { marginBottom: 0 }]}
            value={pttCallsign}
            onChangeText={(v) => { setPttCallsign(v); setIsDirty(true); }}
            placeholder="e.g. Alpha-1 (optional)"
            placeholderTextColor="#555555"
            maxLength={32}
            autoCapitalize="none"
            returnKeyType="done"
            onSubmitEditing={() => { void handleSaveProfile(); }}
            accessibilityLabel="PTT callsign input"
          />
        </View>

        {/* Privacy / visibility */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Profile Visibility</Text>
          <View style={styles.privacyRow}>
            <TouchableOpacity
              style={[styles.privacyBtn, privacy === 'open' && styles.privacyBtnActive]}
              onPress={() => { setPrivacy('open'); setIsDirty(true); }}
              accessibilityRole="button"
              accessibilityLabel="Open — anyone can join"
            >
              <Text style={[styles.privacyBtnText, privacy === 'open' && styles.privacyBtnTextActive]}>Open</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.privacyBtn, privacy === 'invite_only' && styles.privacyBtnActive]}
              onPress={() => { setPrivacy('invite_only'); setIsDirty(true); }}
              accessibilityRole="button"
              accessibilityLabel="Invite only"
            >
              <Text style={[styles.privacyBtnText, privacy === 'invite_only' && styles.privacyBtnTextActive]}>Invite Only</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.saveNameBtn, (!isDirty || isSaving) && styles.btnDisabled, { marginTop: 16 }]}
            onPress={handleSaveProfile}
            disabled={!isDirty || isSaving}
            accessibilityRole="button"
            accessibilityLabel="Save profile"
            accessibilityState={{ disabled: !isDirty || isSaving }}
          >
            {isSaving ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.saveNameBtnText}>Save Profile</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Section divider */}
        <View style={styles.sectionDivider} />

        {/* Friends button */}
        <TouchableOpacity
          style={styles.friendsBtn}
          onPress={() => router.push('/friends')}
          accessibilityRole="button"
          accessibilityLabel="View friends"
        >
          <View style={styles.friendsBtnInner}>
            <Text style={styles.friendsBtnIcon}>👥</Text>
            <Text style={styles.friendsBtnText}>Friends</Text>
          </View>
          <Text style={styles.friendsChevron}>›</Text>
        </TouchableOpacity>

        {/* Settings */}
        <TouchableOpacity
          style={styles.settingsBtn}
          onPress={() => router.push('/(tabs)/settings')}
          accessibilityRole="button"
          accessibilityLabel="Go to Settings"
        >
          <View style={styles.settingsBtnInner}>
            <Text style={styles.settingsBtnIcon}>⚙️</Text>
            <Text style={styles.settingsBtnText}>Settings</Text>
          </View>
          <Text style={styles.settingsChevron}>›</Text>
        </TouchableOpacity>

        {/* Sign out */}
        <TouchableOpacity
          style={styles.signOutBtn}
          onPress={handleSignOut}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
        >
          <Text style={styles.signOutBtnText}>Sign Out</Text>
        </TouchableOpacity>
      </ScrollView>
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
  },
  scroll: {
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 48,
  },
  pageTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#F0F0F0',
    marginBottom: 28,
  },
  errorText: {
    color: '#f87171',
    fontSize: 13,
    marginBottom: 16,
    textAlign: 'center',
  },
  successText: {
    color: '#4ade80',
    fontSize: 13,
    marginBottom: 16,
    textAlign: 'center',
  },

  // Avatar section
  avatarSection: {
    alignItems: 'center',
    marginBottom: 28,
  },
  avatarRing: {
    width: 104,
    height: 104,
    borderRadius: 52,
    borderWidth: 2,
    borderColor: '#DC143C',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    padding: 3,
  },
  avatarCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: '#DC143C',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: {
    fontSize: 34,
    fontWeight: '700',
    color: '#ffffff',
  },
  displayNameRow: {
    marginTop: 4,
    marginBottom: 6,
    alignItems: 'center',
    minWidth: 160,
  },
  displayNameText: {
    fontSize: 22,
    fontWeight: '700',
    color: '#F0F0F0',
    textAlign: 'center',
  },
  editPencil: {
    fontSize: 14,
  },
  displayNameInput: {
    fontSize: 22,
    fontWeight: '700',
    color: '#F0F0F0',
    textAlign: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#DC143C',
    minWidth: 160,
    paddingVertical: 4,
  },
  callsignBadge: {
    backgroundColor: '#1C1C1C',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 5,
    marginBottom: 8,
    marginTop: 2,
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  callsignText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#DC143C',
    letterSpacing: 0.5,
  },
  callsignMuted: {
    color: '#555555',
  },
  accountMeta: {
    fontSize: 13,
    color: '#888888',
  },
  sectionDivider: {
    height: 1,
    backgroundColor: '#1C1C1C',
    marginVertical: 8,
    marginHorizontal: 4,
  },

  // Card
  card: {
    backgroundColor: '#1C1C1C',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    padding: 16,
    marginBottom: 14,
  },
  cardLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#888888',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  nameInput: {
    fontSize: 17,
    color: '#F0F0F0',
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A2A',
    marginBottom: 14,
  },
  saveNameBtn: {
    backgroundColor: '#DC143C',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  btnDisabled: {
    opacity: 0.4,
  },
  saveNameBtnText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  privacyRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  privacyBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    alignItems: 'center',
    backgroundColor: '#0A0A0A',
  },
  privacyBtnActive: {
    borderColor: '#DC143C',
    backgroundColor: '#DC143C',
  },
  privacyBtnText: {
    color: '#888888',
    fontSize: 14,
    fontWeight: '600',
  },
  privacyBtnTextActive: {
    color: '#FFFFFF',
  },

  // Friends button
  friendsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1C1C1C',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 16,
    paddingVertical: 16,
    marginBottom: 14,
    minHeight: 60,
  },
  friendsBtnInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  friendsBtnIcon: {
    fontSize: 20,
    marginRight: 12,
  },
  friendsBtnText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#F0F0F0',
  },
  friendsChevron: {
    fontSize: 22,
    color: '#555555',
    fontWeight: '300',
  },

  // Settings button
  settingsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1C1C1C',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 16,
    paddingVertical: 16,
    marginBottom: 14,
    minHeight: 60,
  },
  settingsBtnInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  settingsBtnIcon: {
    fontSize: 20,
    marginRight: 12,
  },
  settingsBtnText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#F0F0F0',
  },
  settingsChevron: {
    fontSize: 22,
    color: '#555555',
    fontWeight: '300',
  },

  // Sign out
  signOutBtn: {
    marginTop: 24,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#f87171',
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
    minHeight: 52,
    justifyContent: 'center',
  },
  signOutBtnText: {
    color: '#f87171',
    fontSize: 15,
    fontWeight: '600',
  },
});
