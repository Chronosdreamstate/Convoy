import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { FileSystemUploadType } from 'expo-file-system/legacy';
import ProfileCompletionBar from '../../components/ProfileCompletionBar';
import { apiClient } from '../../services/apiClient';
import { SkeletonBox } from '../../components/SkeletonLoader';
import { authService } from '../../services/AuthService';
import { useAuthStore } from '../../stores/authStore';
import { useTheme, ThemeColors } from '../../theme';

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

function AvatarCircle({
  name,
  avatarUrl,
  onPress,
  loading,
  colors,
  styles,
}: {
  name: string;
  avatarUrl?: string | null;
  onPress?: () => void;
  loading?: boolean;
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <TouchableOpacity
      style={styles.avatarRing}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Change profile photo"
      activeOpacity={0.85}
    >
      {avatarUrl ? (
        <Image source={{ uri: avatarUrl }} style={styles.avatarCircle} />
      ) : (
        <View style={styles.avatarCircle}>
          <Text style={styles.avatarInitials}>{initials(name)}</Text>
        </View>
      )}
      <View style={styles.avatarCameraOverlay}>
        <Ionicons name="camera" size={14} color={colors.text} />
      </View>
      {loading && (
        <View style={styles.avatarLoadingOverlay}>
          <ActivityIndicator color={colors.accent} />
        </View>
      )}
    </TouchableOpacity>
  );
}

function CallsignBadge({ callsign, styles }: { callsign: string | null; styles: ReturnType<typeof createStyles> }) {
  return (
    <View style={styles.callsignBadge}>
      {callsign ? (
        <View style={styles.callsignRow}>
          <Ionicons name="radio-outline" size={13} style={styles.callsignIcon} />
          <Text style={styles.callsignText}>{callsign}</Text>
        </View>
      ) : (
        <Text style={[styles.callsignText, styles.callsignMuted]}>No callsign</Text>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function ProfileScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const accessToken = useAuthStore((s) => s.accessToken);
  const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? '';

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
  const [localAvatarUri, setLocalAvatarUri] = useState<string | null>(null);
  const [avatarDirty, setAvatarDirty] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [showAvatarModal, setShowAvatarModal] = useState(false);
  const [avatarUrlDraft, setAvatarUrlDraft] = useState('');
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
        ...(avatarDirty ? { avatarUrl: localAvatarUri } : {}),
      });
      if (!isMounted.current) return;
      setProfile(res.data);
      setDisplayName(res.data.displayName);
      setPttCallsign(res.data.pttCallsign ?? '');
      setPrivacy(res.data.privacy);
      setIsDirty(false);
      setAvatarDirty(false);
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

  const handlePickAvatar = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Please allow photo library access to set a profile photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (result.canceled) return;
    setUploadingAvatar(true);
    try {
      const asset = result.assets[0];
      const uploadResult = await FileSystem.uploadAsync(
        `${apiUrl}/api/v1/uploads/photo`,
        asset.uri,
        {
          httpMethod: 'POST',
          uploadType: FileSystemUploadType.MULTIPART,
          fieldName: 'file',
          mimeType: asset.mimeType ?? 'image/jpeg',
          headers: { Authorization: `Bearer ${accessToken ?? ''}` },
        },
      );
      const { url } = JSON.parse(uploadResult.body) as { url: string };
      setLocalAvatarUri(url);
      setAvatarDirty(true);
      setIsDirty(true);
    } catch {
      Alert.alert('Upload Failed', 'Could not upload photo. Try again.');
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleAvatarPress = () => {
    // Native Alert buttons are plain OS text and cannot host a custom vector
    // icon, so this emoji stays as lightweight shorthand within the dialog copy.
    Alert.alert('Change Photo', '', [
      { text: '📷 Choose from Library', onPress: () => void handlePickAvatar() },
      {
        text: 'Enter Photo URL',
        onPress: () => {
          setAvatarUrlDraft(localAvatarUri ?? profile?.avatarUrl ?? '');
          setShowAvatarModal(true);
        },
      },
      {
        text: 'Remove Photo',
        style: 'destructive',
        onPress: () => { setLocalAvatarUri(null); setAvatarDirty(true); setIsDirty(true); },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const handleAvatarUrlConfirm = () => {
    const trimmed = avatarUrlDraft.trim();
    if (trimmed && !trimmed.startsWith('http')) {
      Alert.alert('Invalid URL', 'Please enter a URL starting with http:// or https://');
      return;
    }
    setLocalAvatarUri(trimmed || null);
    setAvatarDirty(true);
    setIsDirty(true);
    setShowAvatarModal(false);
  };

  const handleShareProfile = async () => {
    const name = displayName || profile?.displayName || 'a CORTEGE rider';
    const callsign = pttCallsign || profile?.pttCallsign;
    const lines = [
      `${name} is on CORTEGE! 🏎️`,
      callsign ? `📻 Callsign: ${callsign}` : '',
      '',
      'Join the convoy: convoy.app',
    ].filter(Boolean);
    try {
      await Share.share({ message: lines.join('\n'), title: `${name} on CORTEGE` });
    } catch { /* dismissed */ }
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
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <Text style={styles.pageTitle}>Profile</Text>
          <View style={[styles.avatarSection, { gap: 12 }]}>
            <SkeletonBox width={104} height={104} borderRadius={52} />
            <SkeletonBox width="45%" height={22} />
            <SkeletonBox width="35%" height={30} borderRadius={20} />
          </View>
          {[0, 1].map((i) => (
            <View key={i} style={[styles.card, { gap: 10 }]}>
              <SkeletonBox width="25%" height={11} />
              <SkeletonBox width="100%" height={44} borderRadius={8} />
            </View>
          ))}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Page title */}
        <View style={styles.pageTitleRow}>
          <Text style={styles.pageTitle}>Profile</Text>
          <TouchableOpacity
            onPress={() => router.push('/notifications')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Notifications"
          >
            <Ionicons name="notifications-outline" size={22} color={colors.text} />
          </TouchableOpacity>
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {saveSuccess ? <Text style={styles.successText}>Profile saved successfully.</Text> : null}

        {/* Avatar + callsign badge */}
        <View style={styles.avatarSection}>
          <AvatarCircle
            name={displayName || profile?.displayName || '?'}
            avatarUrl={localAvatarUri ?? profile?.avatarUrl}
            onPress={uploadingAvatar ? undefined : handleAvatarPress}
            loading={uploadingAvatar}
            colors={colors}
            styles={styles}
          />
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
                placeholderTextColor={colors.textSubtle}
                maxLength={100}
                returnKeyType="done"
                accessibilityLabel="Display name input"
              />
            ) : (
              <View style={styles.displayNameStatic}>
                <Text style={styles.displayNameText} numberOfLines={1}>
                  {displayName || profile?.displayName || ''}
                </Text>
                <Ionicons name="pencil-outline" size={14} color={colors.textMuted} style={styles.editPencil} />
              </View>
            )}
          </TouchableOpacity>
          <CallsignBadge callsign={pttCallsign || (profile?.pttCallsign ?? null)} styles={styles} />
          {profile?.email ? (
            <Text style={styles.accountMeta}>{profile.email}</Text>
          ) : profile?.phoneNumber ? (
            <Text style={styles.accountMeta}>{profile.phoneNumber}</Text>
          ) : null}
        </View>

        {/* Profile completion bar */}
        {profile && (
          <ProfileCompletionBar
            hasCallsign={!!profile.pttCallsign}
            hasVehicle={vehicleCount > 0}
            hasAvatar={!!profile.avatarUrl}
            hasFriend={friendCount > 0}
            onItemPress={(item) => {
              if (item === 'vehicle') router.push('/garage');
              else if (item === 'friend') router.push('/friends');
              else if (item === 'callsign') { /* focus callsign field */ }
            }}
          />
        )}

        {/* Callsign + privacy card */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>PTT Callsign</Text>
          <TextInput
            style={[styles.nameInput, { marginBottom: 0 }]}
            value={pttCallsign}
            onChangeText={(v) => { setPttCallsign(v); setIsDirty(true); }}
            placeholder="e.g. Alpha-1 (optional)"
            placeholderTextColor={colors.textSubtle}
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
              <ActivityIndicator color={colors.text} size="small" />
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
            <Ionicons name="people-outline" size={20} color={colors.text} style={styles.friendsBtnIcon} />
            <Text style={styles.friendsBtnText}>Friends</Text>
          </View>
          <Text style={styles.friendsChevron}>›</Text>
        </TouchableOpacity>

        {/* Share Profile */}
        <TouchableOpacity
          style={styles.friendsBtn}
          onPress={() => { void handleShareProfile(); }}
          accessibilityRole="button"
          accessibilityLabel="Share profile"
        >
          <View style={styles.friendsBtnInner}>
            <Ionicons name="share-social-outline" size={20} color={colors.text} style={styles.friendsBtnIcon} />
            <Text style={styles.friendsBtnText}>Share Profile</Text>
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
            <Ionicons name="settings-outline" size={20} color={colors.text} style={styles.settingsBtnIcon} />
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

      </KeyboardAvoidingView>

      {/* Avatar URL input modal */}
      <Modal
        visible={showAvatarModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAvatarModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Photo URL</Text>
            <Text style={styles.modalSubtitle}>Paste a link to your profile photo</Text>
            <TextInput
              style={styles.modalInput}
              value={avatarUrlDraft}
              onChangeText={setAvatarUrlDraft}
              placeholder="https://example.com/photo.jpg"
              placeholderTextColor={colors.textSubtle}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="done"
              onSubmitEditing={handleAvatarUrlConfirm}
              accessibilityLabel="Avatar photo URL"
            />
            <View style={styles.modalBtnRow}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnCancel]}
                onPress={() => setShowAvatarModal(false)}
              >
                <Text style={styles.modalBtnCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnConfirm]}
                onPress={handleAvatarUrlConfirm}
              >
                <Text style={styles.modalBtnConfirmText}>Apply</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
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
  pageTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 28,
  },
  pageTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 28,
  },
  errorText: {
    color: colors.error,
    fontSize: 13,
    marginBottom: 16,
    textAlign: 'center',
  },
  successText: {
    color: colors.success,
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
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    padding: 3,
  },
  avatarCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: {
    fontSize: 34,
    fontWeight: '700',
    color: colors.text,
  },
  avatarCameraOverlay: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.bg,
  },
  avatarLoadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 52,
    backgroundColor: 'rgba(10, 10, 10, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  displayNameRow: {
    marginTop: 4,
    marginBottom: 6,
    alignItems: 'center',
    minWidth: 160,
  },
  displayNameStatic: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  displayNameText: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
  editPencil: {
    marginTop: 2,
  },
  displayNameInput: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.accent,
    minWidth: 160,
    paddingVertical: 4,
  },
  callsignBadge: {
    backgroundColor: colors.card,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 5,
    marginBottom: 8,
    marginTop: 2,
    borderWidth: 1,
    borderColor: colors.border,
  },
  callsignRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  callsignIcon: {
    color: colors.accent,
  },
  callsignText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent,
    letterSpacing: 0.5,
  },
  callsignMuted: {
    color: colors.textSubtle,
  },
  accountMeta: {
    fontSize: 13,
    color: colors.textMuted,
  },
  sectionDivider: {
    height: 1,
    backgroundColor: colors.card,
    marginVertical: 8,
    marginHorizontal: 4,
  },

  // Card
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    marginBottom: 14,
  },
  cardLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  nameInput: {
    fontSize: 17,
    color: colors.text,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginBottom: 14,
  },
  saveNameBtn: {
    backgroundColor: colors.accent,
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
    color: colors.text,
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
    borderColor: colors.border,
    alignItems: 'center',
    backgroundColor: colors.bg,
  },
  privacyBtnActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  privacyBtnText: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '600',
  },
  privacyBtnTextActive: {
    color: colors.text,
  },

  // Friends button
  friendsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
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
    marginRight: 12,
  },
  friendsBtnText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  friendsChevron: {
    fontSize: 22,
    color: colors.textSubtle,
    fontWeight: '300',
  },

  // Settings button
  settingsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
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
    marginRight: 12,
  },
  settingsBtnText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  settingsChevron: {
    fontSize: 22,
    color: colors.textSubtle,
    fontWeight: '300',
  },

  // Avatar URL modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 4,
  },
  modalSubtitle: {
    fontSize: 13,
    color: colors.textMuted,
    marginBottom: 16,
  },
  modalInput: {
    backgroundColor: colors.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 20,
  },
  modalBtnRow: {
    flexDirection: 'row',
    gap: 12,
  },
  modalBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 10,
    alignItems: 'center',
  },
  modalBtnCancel: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalBtnConfirm: {
    backgroundColor: colors.accent,
  },
  modalBtnCancelText: {
    color: colors.textMuted,
    fontSize: 15,
    fontWeight: '600',
  },
  modalBtnConfirmText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },

  // Sign out
  signOutBtn: {
    marginTop: 24,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.error,
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
    minHeight: 52,
    justifyContent: 'center',
  },
  signOutBtnText: {
    color: colors.error,
    fontSize: 15,
    fontWeight: '600',
  },
  });
}
