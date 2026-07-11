import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Animated,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { apiClient } from '../../services/apiClient';
import { authService } from '../../services/AuthService';
import { SiriShortcutsService } from '../../services/SiriShortcutsService';
import { SkeletonBox } from '../../components/SkeletonLoader';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTheme } from '../../theme';

type Theme = ReturnType<typeof useTheme>;
type IoniconName = keyof typeof Ionicons.glyphMap;

// Text/icons that always sit on the crimson accent fill (active chips, save
// button, switch thumbs on an accent track) — stays light in both themes.
const ON_ACCENT = '#FFFFFF';

interface Settings {
  hazardAlertDistanceM: number;
  tileCacheLimitMb: number;
  scenicRouting: boolean;
  mapStyle: 'standard' | 'satellite' | 'hybrid';
  notifHazard: boolean;
  notifGroupEvents: boolean;
  notifFriendRequests: boolean;
  notifNavigation: boolean;
  visibleToNearby: boolean;
  shareLocationWithFriends: boolean;
}

const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';
const APP_STORE_URL = 'https://apps.apple.com/app/convoy/id0000000000';

const MILES_PER_METRE = 0.000621371;
const MAP_STYLES: Array<{ label: string; value: Settings['mapStyle'] }> = [
  { label: 'Standard', value: 'standard' },
  { label: 'Satellite', value: 'satellite' },
  { label: 'Hybrid', value: 'hybrid' },
];
const DISTANCE_UNITS: Array<{ label: string; value: 'km' | 'miles' }> = [
  { label: 'Kilometres', value: 'km' },
  { label: 'Miles', value: 'miles' },
];
const THEME_MODES: Array<{ label: string; value: 'light' | 'dark' | 'system' }> = [
  { label: 'System', value: 'system' },
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
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
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return <Text style={styles.sectionHeader}>{title}</Text>;
}

// ---------------------------------------------------------------------------
// Row with icon + label + right control
// ---------------------------------------------------------------------------

interface SettingRowProps {
  icon: IoniconName;
  label: string;
  subtitle?: string;
  rightSlot?: React.ReactNode;
  onPress?: () => void;
  danger?: boolean;
  last?: boolean;
  disabled?: boolean;
}

function SettingRow({ icon, label, subtitle, rightSlot, onPress, danger, last, disabled }: SettingRowProps) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const Inner = (
    <View style={[styles.settingRow, last && styles.settingRowLast, disabled && styles.settingRowDisabled]}>
      <View style={styles.settingIcon}>
        <Ionicons name={icon} size={17} color={danger ? theme.colors.accent : theme.colors.textMuted} />
      </View>
      <View style={styles.settingLabelGroup}>
        <Text style={[styles.settingLabel, danger && styles.settingLabelDanger]}>{label}</Text>
        {subtitle ? <Text style={styles.settingSubtitle}>{subtitle}</Text> : null}
      </View>
      <View style={styles.settingRight}>
        {rightSlot ?? (onPress ? <Text style={styles.chevron}>›</Text> : null)}
      </View>
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: !!disabled }}
      >
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
  options: Array<{ label: string; value: T; icon?: IoniconName }>;
  selected: T;
  onSelect: (val: T) => void;
}

function ChipSelector<T extends string | number>({ options, selected, onSelect }: ChipRowProps<T>) {
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={styles.chipRow}>
      {options.map((opt) => {
        const active = selected === opt.value;
        return (
          <TouchableOpacity
            key={String(opt.value)}
            style={[styles.chip, active && styles.chipActive]}
            onPress={() => onSelect(opt.value)}
            accessibilityRole="button"
            accessibilityLabel={opt.label}
          >
            {opt.icon ? (
              <Ionicons
                name={opt.icon}
                size={13}
                color={active ? ON_ACCENT : theme.colors.textMuted}
                style={styles.chipIcon}
              />
            ) : null}
            <Text style={[styles.chipText, active && styles.chipTextActive]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function SettingsScreen() {
  const router = useRouter();
  const theme = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const setGlobalSettings = useSettingsStore((s) => s.setSettings);
  const storedVolumePercent = useSettingsStore((s) => s.pttVolumePercent);
  const storedDistanceUnit = useSettingsStore((s) => s.distanceUnit);
  const storedThemeMode = useSettingsStore((s) => s.themeMode);
  const [, setSettings] = useState<Settings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [isExportingData, setIsExportingData] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const saveSuccessTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSuccessAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    return () => {
      if (saveSuccessTimer.current) clearTimeout(saveSuccessTimer.current);
    };
  }, []);

  useEffect(() => {
    if (saveSuccess) {
      Animated.timing(saveSuccessAnim, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    } else {
      Animated.timing(saveSuccessAnim, { toValue: 0, duration: 250, useNativeDriver: true }).start();
    }
  }, [saveSuccess, saveSuccessAnim]);

  // Local editable copies
  const [mapStyle, setMapStyle] = useState<Settings['mapStyle']>('standard');
  const [hazardDistM, setHazardDistM] = useState(805);
  const [cacheMb, setCacheMb] = useState(500);
  const [pttVolumePercent, setPttVolumePercent] = useState(storedVolumePercent);
  const [scenicRouting, setScenicRouting] = useState(false);
  const [notifHazard, setNotifHazard] = useState(true);
  const [notifGroupEvents, setNotifGroupEvents] = useState(true);
  const [notifFriendRequests, setNotifFriendRequests] = useState(true);
  const [notifNavigation, setNotifNavigation] = useState(true);
  const [shareLocationWithFriends, setShareLocationWithFriends] = useState(false);
  const [distanceUnit, setDistanceUnit] = useState<'km' | 'miles'>(storedDistanceUnit);
  const [themeMode, setThemeMode] = useState<'light' | 'dark' | 'system'>(storedThemeMode);
  const [visibleToNearby, setVisibleToNearby] = useState(false);

  const applySettings = useCallback((s: Settings) => {
    setMapStyle(s.mapStyle);
    setHazardDistM(s.hazardAlertDistanceM);
    setCacheMb(s.tileCacheLimitMb);
    setScenicRouting(s.scenicRouting);
    setNotifHazard(s.notifHazard);
    setNotifGroupEvents(s.notifGroupEvents);
    setNotifFriendRequests(s.notifFriendRequests);
    setNotifNavigation(s.notifNavigation);
    setVisibleToNearby(s.visibleToNearby ?? false);
    // Defensive: the backend field may not exist yet if the friend-location-sharing
    // work hasn't landed on this deployment — default to off (not sharing) either way.
    setShareLocationWithFriends(s.shareLocationWithFriends ?? false);
  }, []);

  const loadSettings = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setIsLoading(true);
    setError(null);
    try {
      const response = await apiClient.get<Settings>('/api/v1/settings');
      const s = response.data;
      applySettings(s);
      setSettings(s);
      setGlobalSettings({
        mapStyle: s.mapStyle,
        hazardAlertDistanceM: s.hazardAlertDistanceM,
        scenicRouting: s.scenicRouting,
        shareLocationWithFriends: s.shareLocationWithFriends ?? false,
      });
      setIsDirty(false);
    } catch {
      setError('Failed to load settings. Please try again.');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [applySettings, setGlobalSettings]);

  // Both deps are stable (useCallback([]) + zustand store action), so this
  // still fetches exactly once on mount.
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // Pull-to-refresh — also doubles as the retry action for the "Failed to
  // load settings" error banner, since that copy promises a way to try again.
  const handleRefresh = () => {
    setIsRefreshing(true);
    void loadSettings({ silent: true });
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
        scenicRouting,
        notifHazard,
        notifGroupEvents,
        notifFriendRequests,
        notifNavigation,
      });
      setSettings(response.data);
      setGlobalSettings({
        mapStyle: response.data.mapStyle,
        hazardAlertDistanceM: response.data.hazardAlertDistanceM,
        scenicRouting: response.data.scenicRouting,
        pttVolumePercent,
        distanceUnit,
        shareLocationWithFriends: response.data.shareLocationWithFriends ?? shareLocationWithFriends,
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
    if (isExportingData) return;
    setIsExportingData(true);
    try {
      const res = await apiClient.get('/api/v1/account/export');
      const json = JSON.stringify(res.data, null, 2);
      const fileUri = `${FileSystem.cacheDirectory}cortege-my-data.json`;
      await FileSystem.writeAsStringAsync(fileUri, json, { encoding: 'utf8' });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(fileUri, {
          mimeType: 'application/json',
          UTI: 'public.json',
          dialogTitle: 'My CORTEGE Data',
        });
      } else {
        // Fallback for environments without a share sheet (e.g. some Android
        // emulators) — share the raw JSON as text so the data isn't lost.
        await Share.share({ message: json, title: 'My CORTEGE Data' });
      }
    } catch {
      Alert.alert('Error', 'Failed to export data. Please try again.');
    } finally {
      setIsExportingData(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (isDeletingAccount) return;
    Alert.alert(
      'Delete Account',
      'This permanently deletes your account and all data. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setIsDeletingAccount(true);
            try {
              await apiClient.delete('/api/v1/account');
              await authService.signOut();
            } catch {
              Alert.alert('Error', 'Failed to delete account. Please try again.');
              setIsDeletingAccount(false);
            }
          },
        },
      ],
    );
  };

  const mark = () => setIsDirty(true);

  // Linking.openURL silently rejects when there's no handler for the URL
  // (e.g. no mail client configured) — surface that instead of the tap
  // appearing to do nothing.
  const handleOpenLink = (url: string, failureMessage: string) => {
    Linking.openURL(url).catch(() => {
      Alert.alert('Unable to Open', failureMessage);
    });
  };

  const handleCheckForUpdates = async () => {
    setCheckingUpdate(true);
    try {
      // expo-updates OTA check — only available in production EAS builds
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
      const Updates = (require as any)('expo-updates') as { checkForUpdateAsync: () => Promise<{ isAvailable: boolean }>; fetchUpdateAsync: () => Promise<void>; reloadAsync: () => Promise<void> };
      const update = await Updates.checkForUpdateAsync();
      if (update.isAvailable) {
        Alert.alert(
          'Update Available',
          'A new version of CORTEGE is available.',
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
    if (isSigningOut) return;
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          setIsSigningOut(true);
          try {
            await authService.signOut();
            router.replace('/(auth)/welcome');
          } catch {
            Alert.alert('Error', 'Failed to sign out. Please try again.');
            setIsSigningOut(false);
          }
        },
      },
    ]);
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <Text style={styles.title}>Settings</Text>
          {[0, 1, 2, 3, 4].map((i) => (
            <View key={i} style={{ marginBottom: 20, gap: 10 }}>
              <SkeletonBox width="30%" height={11} />
              {[0, 1].map((j) => <SkeletonBox key={j} width="100%" height={52} borderRadius={14} />)}
            </View>
          ))}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={theme.colors.accent}
            colors={[theme.colors.accent]}
          />
        }
      >
        <Text style={styles.title}>Settings</Text>

        {error ? (
          <View style={styles.errorRow}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity
              onPress={handleRefresh}
              accessibilityRole="button"
              accessibilityLabel="Retry"
              hitSlop={theme.hitSlop}
            >
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {saveSuccess ? (
          <Animated.Text style={[styles.successText, { opacity: saveSuccessAnim }]}>
            Settings saved.
          </Animated.Text>
        ) : null}

        {/* ── ACCOUNT ─────────────────────────────────────────────────────── */}
        <SectionHeader title="ACCOUNT" />
        <View style={styles.sectionCard}>
          <SettingRow
            icon="person-outline"
            label="Edit Profile"
            onPress={() => router.push('/(tabs)/profile')}
          />
          <SettingRow
            icon="trophy-outline"
            label="Achievements"
            subtitle="Track your convoy milestones"
            onPress={() => router.push('/achievements' as never)}
          />
          <SettingRow
            icon="download-outline"
            label="Export My Data"
            subtitle="Receive a copy of your data"
            onPress={handleExportData}
            disabled={isExportingData}
            rightSlot={isExportingData ? <ActivityIndicator color={theme.colors.accent} size="small" /> : undefined}
          />
          <SettingRow
            icon="lock-closed-outline"
            label="Privacy Policy"
            onPress={() => router.push('/privacy' as never)}
          />
          <SettingRow
            icon="document-text-outline"
            label="Terms of Service"
            onPress={() => router.push('/terms' as never)}
            last
          />
        </View>

        {/* ── NOTIFICATIONS ───────────────────────────────────────────────── */}
        <SectionHeader title="NOTIFICATIONS" />
        <View style={styles.sectionCard}>
          <SettingRow
            icon="warning-outline"
            label="Hazard Alerts"
            subtitle="Nearby road hazard notifications"
            rightSlot={
              <Switch
                value={notifHazard}
                onValueChange={(v) => { setNotifHazard(v); mark(); }}
                trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
                thumbColor={ON_ACCENT}
                accessibilityLabel="Hazard notifications toggle"
              />
            }
          />
          <SettingRow
            icon="people-outline"
            label="Group Events"
            subtitle="Route pushes, mutes, session changes"
            rightSlot={
              <Switch
                value={notifGroupEvents}
                onValueChange={(v) => { setNotifGroupEvents(v); mark(); }}
                trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
                thumbColor={ON_ACCENT}
                accessibilityLabel="Group events notifications toggle"
              />
            }
          />
          <SettingRow
            icon="person-add-outline"
            label="Friend Requests"
            subtitle="Incoming friend requests"
            rightSlot={
              <Switch
                value={notifFriendRequests}
                onValueChange={(v) => { setNotifFriendRequests(v); mark(); }}
                trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
                thumbColor={ON_ACCENT}
                accessibilityLabel="Friend requests notifications toggle"
              />
            }
          />
          <SettingRow
            icon="compass-outline"
            label="Navigation"
            subtitle="Arriving at destination alerts"
            rightSlot={
              <Switch
                value={notifNavigation}
                onValueChange={(v) => { setNotifNavigation(v); mark(); }}
                trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
                thumbColor={ON_ACCENT}
                accessibilityLabel="Navigation notifications toggle"
              />
            }
            last
          />
        </View>

        {/* ── PRIVACY & VISIBILITY ────────────────────────────────────────── */}
        {/* Everything that controls who can see or contact you lives in one
            place — previously split across three separate sections (Nearby,
            Privacy, Location Sharing) scattered around the screen. */}
        <SectionHeader title="PRIVACY & VISIBILITY" />
        <View style={styles.sectionCard}>
          <SettingRow
            icon="radio-outline"
            label="Visible to Nearby Drivers"
            subtitle="Let other opted-in drivers see your approximate distance and start a chat"
            rightSlot={
              <Switch
                value={visibleToNearby}
                // Applied instantly (not gated behind Save) — this controls
                // whether the user is discoverable by strangers, so "off"
                // must take effect the moment it's toggled, not whenever the
                // user next remembers to scroll down and tap Save Settings.
                onValueChange={async (v) => {
                  const prev = visibleToNearby;
                  setVisibleToNearby(v);
                  try {
                    const response = await apiClient.patch<Settings>('/api/v1/settings', { visibleToNearby: v });
                    setSettings(response.data);
                  } catch {
                    setVisibleToNearby(prev);
                    setError('Failed to update nearby visibility. Please try again.');
                  }
                }}
                trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
                thumbColor={ON_ACCENT}
                accessibilityLabel="Visible to nearby drivers toggle"
              />
            }
          />
          <SettingRow
            icon="location-outline"
            label="Share My Location"
            subtitle="Friends can see your live location when this is on"
            rightSlot={
              <Switch
                value={shareLocationWithFriends}
                // Applied instantly (not gated behind Save) — this controls
                // whether friends can see live location. "Off" must take
                // effect the moment it's toggled, matching the Visible-to-
                // Nearby setting's instant-apply behavior above, not whenever
                // the user next remembers to tap Save Settings.
                onValueChange={async (v) => {
                  const prev = shareLocationWithFriends;
                  setShareLocationWithFriends(v);
                  try {
                    const response = await apiClient.patch<Settings>('/api/v1/settings', { shareLocationWithFriends: v });
                    setSettings(response.data);
                    setGlobalSettings({ shareLocationWithFriends: response.data.shareLocationWithFriends ?? v });
                  } catch {
                    setShareLocationWithFriends(prev);
                    setError('Failed to update location sharing. Please try again.');
                  }
                }}
                trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
                thumbColor={ON_ACCENT}
                accessibilityLabel="Share my location with friends toggle"
              />
            }
          />
          {shareLocationWithFriends ? (
            <View style={styles.shareLocationBanner}>
              <Text style={styles.shareLocationBannerText}>
                Your live location is currently visible to friends
              </Text>
            </View>
          ) : null}
          <SettingRow
            icon="eye-outline"
            label="Friend Request Privacy"
            subtitle="Choose who can send you friend requests"
            onPress={() => router.push('/(tabs)/profile')}
          />
          <SettingRow
            icon="ban-outline"
            label="Blocked Users"
            subtitle="View and unblock users you've blocked"
            onPress={() => router.push('/blocked-users' as never)}
            last
          />
        </View>

        {/* ── APPEARANCE ──────────────────────────────────────────────────── */}
        <SectionHeader title="APPEARANCE" />
        <View style={styles.sectionCard}>
          <SettingRow
            icon="contrast-outline"
            label="Theme"
            subtitle={themeMode === 'system' ? 'Follows system setting' : themeMode === 'dark' ? 'Dark' : 'Light'}
            last
          />
          <View style={styles.chipContainer}>
            <ChipSelector
              options={THEME_MODES}
              selected={themeMode}
              // Applied instantly (not gated behind Save) — a pure device
              // rendering preference with no server component, unlike the
              // other settings on this screen.
              onSelect={(v) => { setThemeMode(v); setGlobalSettings({ themeMode: v }); }}
            />
          </View>
        </View>

        {/* ── MAP & NAVIGATION ────────────────────────────────────────────── */}
        {/* Map rendering, routing, hazard alerts, and offline caching are all
            wayfinding settings — merged from three previously separate
            single-item sections (Map, Navigation, Offline) for scanability. */}
        <SectionHeader title="MAP & NAVIGATION" />
        <View style={styles.sectionCard}>
          <SettingRow
            icon="map-outline"
            label="Map Style"
            subtitle={`Current: ${mapStyle.charAt(0).toUpperCase() + mapStyle.slice(1)}`}
            last
          />
          <View style={[styles.chipContainer, styles.chipContainerDivider]}>
            <ChipSelector
              options={MAP_STYLES}
              selected={mapStyle}
              onSelect={(v) => { setMapStyle(v); mark(); }}
            />
          </View>
          <SettingRow
            icon="swap-horizontal-outline"
            label="Distance Units"
            subtitle={`Showing distances in ${distanceUnit}`}
            last
          />
          <View style={[styles.chipContainer, styles.chipContainerDivider]}>
            <ChipSelector
              options={DISTANCE_UNITS}
              selected={distanceUnit}
              onSelect={(v) => { setDistanceUnit(v); mark(); }}
            />
          </View>
          <SettingRow
            icon="trail-sign-outline"
            label="Scenic Routing"
            subtitle="Prefer roads that avoid highways"
            rightSlot={
              <Switch
                value={scenicRouting}
                onValueChange={(v) => { setScenicRouting(v); mark(); }}
                trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
                thumbColor={ON_ACCENT}
                accessibilityLabel="Scenic routing toggle"
              />
            }
          />
          <SettingRow
            icon="warning-outline"
            label="Hazard Alert Distance"
            subtitle={`Alert within ${(hazardDistM * MILES_PER_METRE).toFixed(2)} miles`}
            last
          />
          <View style={[styles.chipContainer, styles.chipContainerDivider]}>
            <ChipSelector
              options={HAZARD_DISTANCES.map((d) => ({ label: d.label, value: d.metres }))}
              selected={hazardDistM}
              onSelect={(v) => { setHazardDistM(v); mark(); }}
            />
          </View>
          <SettingRow
            icon="save-outline"
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

        {/* ── AUDIO ───────────────────────────────────────────────────────── */}
        <SectionHeader title="AUDIO" />
        <View style={styles.sectionCard}>
          <SettingRow
            icon="volume-high-outline"
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

        {/* ── CARPLAY ─────────────────────────────────────────────────────── */}
        <SectionHeader title="CARPLAY" />
        <View style={styles.sectionCard}>
          <SettingRow
            icon="car-outline"
            label="CarPlay / Android Auto"
            subtitle="Connect to your vehicle to configure head unit settings"
          />
          <SettingRow
            icon="mic-circle-outline"
            label="Siri Shortcuts"
            subtitle="4 shortcuts available — say 'Start my convoy'"
            onPress={() => { void SiriShortcutsService.donateAll(); }}
            last
          />
        </View>

        {/* ── ABOUT ───────────────────────────────────────────────────────── */}
        <SectionHeader title="ABOUT" />
        <View style={styles.sectionCard}>
          <SettingRow
            icon="refresh-outline"
            label="Check for Updates"
            subtitle="Check for the latest version of CORTEGE"
            onPress={() => { void handleCheckForUpdates(); }}
            rightSlot={
              checkingUpdate
                ? <ActivityIndicator color={theme.colors.accent} size="small" />
                : undefined
            }
          />
          <SettingRow
            icon="star-outline"
            label="Rate CORTEGE"
            subtitle="Love the app? Leave us a review"
            onPress={() => handleOpenLink(APP_STORE_URL, 'Could not open the App Store. Please try again later.')}
          />
          <SettingRow
            icon="mail-outline"
            label="Send Feedback"
            subtitle="hello@convoy.app"
            onPress={() => handleOpenLink('mailto:hello@convoy.app?subject=Feedback', 'No email app is set up on this device.')}
          />
          <SettingRow
            icon="chatbubble-outline"
            label="Contact Support"
            subtitle="Get help from the CORTEGE team"
            onPress={() => handleOpenLink('mailto:support@convoy.app?subject=Support%20Request', 'No email app is set up on this device.')}
          />
          <SettingRow
            icon="information-circle-outline"
            label="Version"
            subtitle={`CORTEGE v${APP_VERSION}`}
            rightSlot={<Text style={styles.versionText}>v{APP_VERSION}</Text>}
            last
          />
        </View>

        {/* ── DANGER ZONE ─────────────────────────────────────────────────── */}
        <SectionHeader title="DANGER ZONE" />
        <View style={[styles.sectionCard, styles.dangerCard]}>
          <SettingRow
            icon="trash-outline"
            label="Delete Account"
            subtitle="Permanently remove your account and data"
            onPress={handleDeleteAccount}
            disabled={isDeletingAccount}
            rightSlot={isDeletingAccount ? <ActivityIndicator color={theme.colors.accent} size="small" /> : undefined}
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
            <ActivityIndicator color={ON_ACCENT} />
          ) : (
            <Text style={styles.saveButtonText}>Save Settings</Text>
          )}
        </TouchableOpacity>

        {/* Sign out — separated from save by a spacer */}
        <View style={styles.signOutSpacer} />
        <TouchableOpacity
          style={[styles.signOutButton, isSigningOut && styles.saveButtonDisabled]}
          onPress={() => { void handleSignOut(); }}
          disabled={isSigningOut}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          accessibilityState={{ disabled: isSigningOut }}
        >
          {isSigningOut ? (
            <ActivityIndicator color={theme.colors.accent} size="small" />
          ) : (
            <Text style={styles.signOutButtonText}>Sign Out</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(theme: Theme) {
  return StyleSheet.create({
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
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: theme.spacing.md,
  },
  errorText: {
    color: theme.colors.error,
    fontSize: 13,
    flexShrink: 1,
    paddingRight: theme.spacing.sm,
  },
  retryText: {
    color: theme.colors.accent,
    fontSize: 13,
    fontWeight: '700',
    textDecorationLine: 'underline',
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
  dangerCard: {
    borderColor: theme.colors.accent,
    borderWidth: 1.5,
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
  settingRowDisabled: {
    opacity: 0.5,
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
  // Applied to a chipContainer that is followed by another setting row within
  // the same card, so the divider separates this control from the *next*
  // setting instead of (incorrectly) separating a row's label from its own
  // chips — see settingRow/settingRowLast below.
  chipContainerDivider: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
  },

  // Share-location status banner — shown under the toggle while it's on, so
  // the user is never surprised their location is currently visible to friends.
  shareLocationBanner: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 10,
    backgroundColor: theme.colors.accentMuted,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  shareLocationBannerText: {
    fontSize: 12,
    color: theme.colors.text,
    fontWeight: '600',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.bg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    minWidth: 44,
  },
  chipIcon: {
    marginRight: 5,
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
    color: ON_ACCENT,
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
    color: ON_ACCENT,
    fontSize: 16,
    fontWeight: '700',
  },
  });
}
