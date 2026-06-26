import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  ActivityIndicator,
  Alert,
  Switch,
  Share,
  Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { apiClient } from '../../services/apiClient';
import { authService } from '../../services/AuthService';
import { useSettingsStore } from '../../stores/settingsStore';
import { theme } from '../../theme';

const PRIVACY_POLICY_URL = 'https://convoy.app/privacy';
const TERMS_URL = 'https://convoy.app/terms';

interface Settings {
  hazardAlertDistanceM: number;
  pttMaxSeconds: number;
  tileCacheLimitMb: number;
  scenicRouting: boolean;
  mapStyle: 'standard' | 'satellite' | 'hybrid';
  notifHazard: boolean;
  notifGroupEvents: boolean;
  notifFriendRequests: boolean;
  notifNavigation: boolean;
  privacy: 'public' | 'friends' | 'private';
}

const PRIVACY_OPTIONS: Array<{ label: string; value: Settings['privacy'] }> = [
  { label: '🌐 Public', value: 'public' },
  { label: '👥 Friends', value: 'friends' },
  { label: '🔒 Private', value: 'private' },
];

const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';
const APP_STORE_URL = 'https://apps.apple.com/app/convoy/id0000000000';

const MILES_PER_METRE = 0.000621371;
const MAP_STYLES: Array<{ label: string; value: Settings['mapStyle'] }> = [
  { label: 'Standard', value: 'standard' },
  { label: 'Satellite', value: 'satellite' },
  { label: 'Hybrid', value: 'hybrid' },
];
const HAZARD_DISTANCES = [
  { label: '0.25 mi', metres: 402 },
  { label: '0.5 mi', metres: 805 },
  { label: '1 mi', metres: 1609 },
  { label: '2 mi', metres: 3219 },
];
const CACHE_SIZES = [
  { label: '100 MB', mb: 100 },
  { label: '250 MB', mb: 250 },
  { label: '500 MB', mb: 500 },
];
const PTT_DURATIONS = [
  { label: '15 s', seconds: 15 },
  { label: '30 s', seconds: 30 },
  { label: '60 s', seconds: 60 },
];
const PTT_VOLUME_LEVELS = [
  { label: '25%', value: 25 },
  { label: '50%', value: 50 },
  { label: '75%', value: 75 },
  { label: '100%', value: 100 },
];

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------

function SectionHeader({ title }: { title: string }) {
  return <Text style={styles.sectionHeader}>{title}</Text>;
}

// ---------------------------------------------------------------------------
// Row with icon + label + right control
// ---------------------------------------------------------------------------

interface SettingRowProps {
  icon: string;
  label: string;
  subtitle?: string;
  rightSlot?: React.ReactNode;
  onPress?: () => void;
  danger?: boolean;
  last?: boolean;
}

function SettingRow({ icon, label, subtitle, rightSlot, onPress, danger, last }: SettingRowProps) {
  const Inner = (
    <View style={[styles.settingRow, last && styles.settingRowLast]}>
      <View style={styles.settingIcon}>
        <Text style={styles.settingIconText}>{icon}</Text>
      </View>
      <View style={styles.settingLabelGroup}>
        <Text style={[styles.settingLabel, danger && styles.settingLabelDanger]}>{label}</Text>
        {subtitle ? <Text style={styles.settingSubtitle}>{subtitle}</Text> : null}
      </View>
      <View style={styles.settingRight}>
        {rightSlot ?? <Text style={styles.chevron}>›</Text>}
      </View>
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
        {Inner}
      </TouchableOpacity>
    );
  }
  return Inner;
}

// ---------------------------------------------------------------------------
// Chip selector
// ---------------------------------------------------------------------------

interface ChipRowProps<T extends string | number> {
  options: Array<{ label: string; value: T }>;
  selected: T;
  onSelect: (val: T) => void;
}

function ChipSelector<T extends string | number>({ options, selected, onSelect }: ChipRowProps<T>) {
  return (
    <View style={styles.chipRow}>
      {options.map((opt) => (
        <TouchableOpacity
          key={String(opt.value)}
          style={[styles.chip, selected === opt.value && styles.chipActive]}
          onPress={() => onSelect(opt.value)}
          accessibilityRole="button"
          accessibilityLabel={opt.label}
        >
          <Text style={[styles.chipText, selected === opt.value && styles.chipTextActive]}>
            {opt.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function SettingsScreen() {
  const router = useRouter();
  const setGlobalSettings = useSettingsStore((s) => s.setSettings);
  const storedVolumePercent = useSettingsStore((s) => s.pttVolumePercent);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const saveSuccessTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (saveSuccessTimer.current) clearTimeout(saveSuccessTimer.current);
    };
  }, []);

  // Local editable copies
  const [mapStyle, setMapStyle] = useState<Settings['mapStyle']>('standard');
  const [hazardDistM, setHazardDistM] = useState(805);
  const [cacheMb, setCacheMb] = useState(500);
  const [pttMaxSecs, setPttMaxSecs] = useState(30);
  const [pttVolumePercent, setPttVolumePercent] = useState(storedVolumePercent);
  const [scenicRouting, setScenicRouting] = useState(false);
  const [notifHazard, setNotifHazard] = useState(true);
  const [notifGroupEvents, setNotifGroupEvents] = useState(true);
  const [notifFriendRequests, setNotifFriendRequests] = useState(true);
  const [notifNavigation, setNotifNavigation] = useState(true);
  const [privacy, setPrivacy] = useState<Settings['privacy']>('public');

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await apiClient.get<Settings>('/api/v1/settings');
      const s = response.data;
      applySettings(s);
      setSettings(s);
      setGlobalSettings({ mapStyle: s.mapStyle, hazardAlertDistanceM: s.hazardAlertDistanceM, scenicRouting: s.scenicRouting, pttMaxSeconds: s.pttMaxSeconds });
      setIsDirty(false);
    } catch {
      setError('Failed to load settings. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const applySettings = (s: Settings) => {
    setMapStyle(s.mapStyle);
    setHazardDistM(s.hazardAlertDistanceM);
    setCacheMb(s.tileCacheLimitMb);
    setPttMaxSecs(s.pttMaxSeconds);
    setScenicRouting(s.scenicRouting);
    setNotifHazard(s.notifHazard);
    setNotifGroupEvents(s.notifGroupEvents);
    setNotifFriendRequests(s.notifFriendRequests);
    setNotifNavigation(s.notifNavigation);
    if (s.privacy) setPrivacy(s.privacy);
  };

  const handleSave = async () => {
    if (!isDirty) return;
    setIsSaving(true);
    setError(null);
    try {
      const response = await apiClient.patch<Settings>('/api/v1/settings', {
        mapStyle,
        hazardAlertDistanceM: hazardDistM,
        tileCacheLimitMb: cacheMb,
        pttMaxSeconds: pttMaxSecs,
        scenicRouting,
        notifHazard,
        notifGroupEvents,
        notifFriendRequests,
        notifNavigation,
        privacy,
      });
      setSettings(response.data);
      setGlobalSettings({
        mapStyle: response.data.mapStyle,
        hazardAlertDistanceM: response.data.hazardAlertDistanceM,
        scenicRouting: response.data.scenicRouting,
        pttMaxSeconds: response.data.pttMaxSeconds,
        pttVolumePercent,
      });
      setIsDirty(false);
      setSaveSuccess(true);
      if (saveSuccessTimer.current) clearTimeout(saveSuccessTimer.current);
      saveSuccessTimer.current = setTimeout(() => setSaveSuccess(false), 3000);
    } catch {
      setError('Failed to save settings. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleExportData = async () => {
    try {
      const res = await apiClient.get('/api/v1/account/export');
      const json = JSON.stringify(res.data, null, 2);
      await Share.share({ message: json, title: 'My CONVOY Data' });
    } catch {
      Alert.alert('Error', 'Failed to export data. Please try again.');
    }
  };

  const handleDeleteAccount = async () => {
    Alert.alert(
      'Delete Account',
      'This permanently deletes your account and all data. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await apiClient.delete('/api/v1/account');
              await authService.signOut();
            } catch {
              Alert.alert('Error', 'Failed to delete account. Please try again.');
            }
          },
        },
      ],
    );
  };

  const mark = () => setIsDirty(true);

  const handleCheckForUpdates = async () => {
    setCheckingUpdate(true);
    try {
      // expo-updates OTA check — only available in production EAS builds
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Updates = require('expo-updates') as { checkForUpdateAsync: () => Promise<{ isAvailable: boolean }>; fetchUpdateAsync: () => Promise<void>; reloadAsync: () => Promise<void> };
      const update = await Updates.checkForUpdateAsync();
      if (update.isAvailable) {
        Alert.alert(
          'Update Available',
          'A new version of CONVOY is available.',
          [
            { text: 'Later', style: 'cancel' },
            {
              text: 'Restart',
              onPress: async () => {
                await Updates.fetchUpdateAsync();
                await Updates.reloadAsync();
              },
            },
          ],
        );
      } else {
        Alert.alert('Up to Date', "You're on the latest version!");
      }
    } catch {
      Alert.alert('Not Available', 'Updates are only available in production builds.');
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleSignOut = async () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          try {
            await authService.signOut();
            router.replace('/(auth)/welcome');
          } catch {
            Alert.alert('Error', 'Failed to sign out. Please try again.');
          }
        },
      },
    ]);
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <ActivityIndicator color={theme.colors.accent} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>Settings</Text>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {saveSuccess ? <Text style={styles.successText}>Settings saved.</Text> : null}

        {/* ── ACCOUNT ─────────────────────────────────────────────────────── */}
        <SectionHeader title="ACCOUNT" />
        <View style={styles.sectionCard}>
          <SettingRow
            icon="👤"
            label="Edit Profile"
            onPress={() => router.push('/(tabs)/profile')}
          />
          <SettingRow
            icon="📤"
            label="Export My Data"
            subtitle="Receive a copy of your data"
            onPress={handleExportData}
          />
          <SettingRow
            icon="🔐"
            label="Privacy Policy"
            onPress={() => Linking.openURL(PRIVACY_POLICY_URL).catch(() => {})}
          />
          <SettingRow
            icon="📄"
            label="Terms of Service"
            onPress={() => Linking.openURL(TERMS_URL).catch(() => {})}
            last
          />
        </View>

        {/* ── NOTIFICATIONS ───────────────────────────────────────────────── */}
        <SectionHeader title="NOTIFICATIONS" />
        <View style={styles.sectionCard}>
          <SettingRow
            icon="⚠️"
            label="Hazard Alerts"
            subtitle="Nearby road hazard notifications"
            rightSlot={
              <Switch
                value={notifHazard}
                onValueChange={(v) => { setNotifHazard(v); mark(); }}
                trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
                thumbColor={theme.colors.text}
                accessibilityLabel="Hazard notifications toggle"
              />
            }
          />
          <SettingRow
            icon="👥"
            label="Group Events"
            subtitle="Route pushes, mutes, session changes"
            rightSlot={
              <Switch
                value={notifGroupEvents}
                onValueChange={(v) => { setNotifGroupEvents(v); mark(); }}
                trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
                thumbColor={theme.colors.text}
                accessibilityLabel="Group events notifications toggle"
              />
            }
          />
          <SettingRow
            icon="🤝"
            label="Friend Requests"
            subtitle="Incoming friend requests"
            rightSlot={
              <Switch
                value={notifFriendRequests}
                onValueChange={(v) => { setNotifFriendRequests(v); mark(); }}
                trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
                thumbColor={theme.colors.text}
                accessibilityLabel="Friend requests notifications toggle"
              />
            }
          />
          <SettingRow
            icon="🧭"
            label="Navigation"
            subtitle="Arriving at destination alerts"
            rightSlot={
              <Switch
                value={notifNavigation}
                onValueChange={(v) => { setNotifNavigation(v); mark(); }}
                trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
                thumbColor={theme.colors.text}
                accessibilityLabel="Navigation notifications toggle"
              />
            }
            last
          />
        </View>

        {/* ── MAP ─────────────────────────────────────────────────────────── */}
        <SectionHeader title="MAP" />
        <View style={styles.sectionCard}>
          <SettingRow
            icon="🗺"
            label="Map Style"
            subtitle={`Current: ${mapStyle.charAt(0).toUpperCase() + mapStyle.slice(1)}`}
          />
          <View style={styles.chipContainer}>
            <ChipSelector
              options={MAP_STYLES}
              selected={mapStyle}
              onSelect={(v) => { setMapStyle(v); mark(); }}
            />
          </View>
          <SettingRow
            icon="🌄"
            label="Scenic Routing"
            subtitle="Prefer roads that avoid highways"
            rightSlot={
              <Switch
                value={scenicRouting}
                onValueChange={(v) => { setScenicRouting(v); mark(); }}
                trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
                thumbColor={theme.colors.text}
                accessibilityLabel="Scenic routing toggle"
              />
            }
            last
          />
        </View>

        {/* ── NAVIGATION ──────────────────────────────────────────────────── */}
        <SectionHeader title="NAVIGATION" />
        <View style={styles.sectionCard}>
          <SettingRow
            icon="⚠️"
            label="Hazard Alert Distance"
            subtitle={`Alert within ${(hazardDistM * MILES_PER_METRE).toFixed(2)} miles`}
          />
          <View style={styles.chipContainer}>
            <ChipSelector
              options={HAZARD_DISTANCES.map((d) => ({ label: d.label, value: d.metres }))}
              selected={hazardDistM}
              onSelect={(v) => { setHazardDistM(v); mark(); }}
            />
          </View>
          <SettingRow
            icon="🎙"
            label="PTT Max Duration"
            subtitle={`${pttMaxSecs} seconds`}
            last
          />
          <View style={styles.chipContainer}>
            <ChipSelector
              options={PTT_DURATIONS.map((d) => ({ label: d.label, value: d.seconds }))}
              selected={pttMaxSecs}
              onSelect={(v) => { setPttMaxSecs(v); mark(); }}
            />
          </View>
        </View>

        {/* ── AUDIO ───────────────────────────────────────────────────────── */}
        <SectionHeader title="AUDIO" />
        <View style={styles.sectionCard}>
          <SettingRow
            icon="🔊"
            label="PTT Playback Volume"
            subtitle={`${pttVolumePercent}% — playback level for incoming transmissions`}
            last
          />
          <View style={styles.chipContainer}>
            <ChipSelector
              options={PTT_VOLUME_LEVELS}
              selected={pttVolumePercent}
              onSelect={(v) => { setPttVolumePercent(v); mark(); }}
            />
          </View>
        </View>

        {/* ── OFFLINE ─────────────────────────────────────────────────────── */}
        <SectionHeader title="OFFLINE" />
        <View style={styles.sectionCard}>
          <SettingRow
            icon="💾"
            label="Map Cache Size"
            subtitle={`${cacheMb} MB stored for offline use`}
            last
          />
          <View style={styles.chipContainer}>
            <ChipSelector
              options={CACHE_SIZES.map((c) => ({ label: c.label, value: c.mb }))}
              selected={cacheMb}
              onSelect={(v) => { setCacheMb(v); mark(); }}
            />
          </View>
        </View>

        {/* ── CARPLAY ─────────────────────────────────────────────────────── */}
        <SectionHeader title="CARPLAY" />
        <View style={styles.sectionCard}>
          <SettingRow
            icon="🚗"
            label="CarPlay / Android Auto"
            subtitle="Connect to your vehicle to configure head unit settings"
            last
          />
        </View>

        {/* ── PRIVACY ─────────────────────────────────────────────────────── */}
        <SectionHeader title="PRIVACY" />
        <View style={styles.sectionCard}>
          <SettingRow
            icon="👁"
            label="Profile Visibility"
            subtitle={`Who can see your profile: ${privacy.charAt(0).toUpperCase() + privacy.slice(1)}`}
          />
          <View style={styles.chipContainer}>
            <ChipSelector
              options={PRIVACY_OPTIONS}
              selected={privacy}
              onSelect={(v) => { setPrivacy(v); mark(); }}
            />
          </View>
        </View>

        {/* ── ABOUT ───────────────────────────────────────────────────────── */}
        <SectionHeader title="ABOUT" />
        <View style={styles.sectionCard}>
          <SettingRow
            icon="🔄"
            label="Check for Updates"
            subtitle="Check for the latest version of CONVOY"
            onPress={() => { void handleCheckForUpdates(); }}
            rightSlot={
              checkingUpdate
                ? <ActivityIndicator color={theme.colors.accent} size="small" />
                : undefined
            }
          />
          <SettingRow
            icon="⭐"
            label="Rate CONVOY"
            subtitle="Love the app? Leave us a review"
            onPress={() => Linking.openURL(APP_STORE_URL).catch(() => {})}
          />
          <SettingRow
            icon="📧"
            label="Send Feedback"
            subtitle="hello@convoy.app"
            onPress={() => Linking.openURL('mailto:hello@convoy.app?subject=Feedback').catch(() => {})}
          />
          <SettingRow
            icon="🔒"
            label="Privacy Policy"
            onPress={() => Linking.openURL(PRIVACY_POLICY_URL).catch(() => {})}
          />
          <SettingRow
            icon="ℹ️"
            label="Version"
            subtitle={`CONVOY v${APP_VERSION}`}
            rightSlot={<Text style={styles.versionText}>v{APP_VERSION}</Text>}
            last
          />
        </View>

        {/* ── DANGER ZONE ─────────────────────────────────────────────────── */}
        <SectionHeader title="DANGER ZONE" />
        <View style={styles.sectionCard}>
          <SettingRow
            icon="🗑"
            label="Delete Account"
            subtitle="Permanently remove your account and data"
            onPress={handleDeleteAccount}
            danger
            last
          />
        </View>

        {/* Save button */}
        <TouchableOpacity
          style={[styles.saveButton, (!isDirty || isSaving) && styles.saveButtonDisabled]}
          onPress={handleSave}
          disabled={!isDirty || isSaving}
          accessibilityRole="button"
          accessibilityLabel="Save settings"
          accessibilityState={{ disabled: !isDirty || isSaving }}
        >
          {isSaving ? (
            <ActivityIndicator color={theme.colors.text} />
          ) : (
            <Text style={styles.saveButtonText}>Save Settings</Text>
          )}
        </TouchableOpacity>

        {/* Sign out — separated from save by a spacer */}
        <View style={styles.signOutSpacer} />
        <TouchableOpacity
          style={styles.signOutButton}
          onPress={() => { void handleSignOut(); }}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
        >
          <Text style={styles.signOutButtonText}>Sign Out</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bg,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scroll: {
    paddingHorizontal: 20,
    paddingTop: theme.spacing.lg,
    paddingBottom: theme.spacing.xxl,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: theme.spacing.lg,
  },
  errorText: {
    color: theme.colors.accent,
    fontSize: 13,
    marginBottom: theme.spacing.md,
  },
  successText: {
    color: theme.colors.success,
    fontSize: 13,
    marginBottom: theme.spacing.md,
  },

  // Section header
  sectionHeader: {
    fontSize: 11,
    fontWeight: '700',
    color: theme.colors.textMuted,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: theme.spacing.sm,
    marginTop: theme.spacing.md,
    paddingHorizontal: theme.spacing.xs,
  },

  // Section card wrapping rows
  sectionCard: {
    backgroundColor: theme.colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: theme.spacing.lg,
    overflow: 'hidden',
  },

  // Setting row
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    minHeight: 56,
  },
  settingRowLast: {
    borderBottomWidth: 0,
  },
  settingIcon: {
    width: 32,
    height: 32,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    flexShrink: 0,
  },
  settingIconText: { fontSize: 16 },
  settingLabelGroup: { flex: 1, paddingRight: theme.spacing.sm },
  settingLabel: {
    fontSize: 15,
    color: theme.colors.text,
    fontWeight: '500',
  },
  settingLabelDanger: {
    color: theme.colors.accent,
  },
  settingSubtitle: {
    fontSize: 12,
    color: theme.colors.textMuted,
    marginTop: 2,
  },
  settingRight: {
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 44,
    minHeight: 44,
  },
  chevron: {
    color: theme.colors.textSubtle,
    fontSize: 20,
    fontWeight: '300',
  },

  // Chip selector (inside a section card, below its row)
  chipContainer: {
    paddingHorizontal: theme.spacing.md,
    paddingBottom: 14,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.bg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    minWidth: 44,
    alignItems: 'center',
  },
  chipActive: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  chipText: {
    color: theme.colors.textMuted,
    fontSize: 13,
    fontWeight: '500',
  },
  chipTextActive: {
    color: theme.colors.text,
    fontWeight: '700',
  },

  // Sign out
  signOutSpacer: {
    height: 20,
  },
  signOutButton: {
    borderRadius: 14,
    paddingVertical: theme.spacing.md,
    alignItems: 'center',
    minHeight: 52,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.colors.accent,
    marginBottom: theme.spacing.sm,
  },
  signOutButtonText: {
    color: theme.colors.accent,
    fontSize: 16,
    fontWeight: '600',
  },

  versionText: {
    fontSize: 13,
    color: theme.colors.textMuted,
    fontWeight: '500',
  },

  // Save button
  saveButton: {
    backgroundColor: theme.colors.accent,
    borderRadius: 14,
    paddingVertical: theme.spacing.md,
    alignItems: 'center',
    marginTop: theme.spacing.sm,
    minHeight: 52,
    justifyContent: 'center',
  },
  saveButtonDisabled: {
    opacity: 0.4,
  },
  saveButtonText: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
});
