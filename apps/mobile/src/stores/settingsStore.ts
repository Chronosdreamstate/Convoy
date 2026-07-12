import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import * as SecureStore from 'expo-secure-store';

export type MapStyle = 'standard' | 'satellite' | 'hybrid';
export type DistanceUnit = 'km' | 'miles';
export type ThemeMode = 'light' | 'dark' | 'system';

interface SettingsState {
  mapStyle: MapStyle;
  hazardAlertDistanceM: number;
  scenicRouting: boolean;
  pttMaxSeconds: number;
  pttVolumePercent: number;
  distanceUnit: DistanceUnit;
  themeMode: ThemeMode;
  shareLocationWithFriends: boolean;
  setSettings: (s: Partial<Pick<SettingsState, 'mapStyle' | 'hazardAlertDistanceM' | 'scenicRouting' | 'pttMaxSeconds' | 'pttVolumePercent' | 'distanceUnit' | 'themeMode' | 'shareLocationWithFriends'>>) => void;
  resetForSignOut: () => void;
}

// Account-level preference defaults — exactly what a fresh install starts with.
// These are reset on sign-out so the next account on this device doesn't
// inherit the previous account's preferences (shareLocationWithFriends in
// particular is a privacy setting that must never leak across accounts).
//
// Device-vs-account split: `themeMode` is deliberately NOT in this list. It is
// a device-level display preference (it tracks the OS appearance of the phone,
// not the identity of the account) and resetting it would flash the UI from
// dark to light mid sign-out. Everything else is per-account.
const ACCOUNT_DEFAULTS = {
  mapStyle: 'standard' as MapStyle,
  hazardAlertDistanceM: 805,
  scenicRouting: false,
  pttMaxSeconds: 30,
  pttVolumePercent: 100,
  distanceUnit: 'miles' as DistanceUnit,
  shareLocationWithFriends: false,
};

// SecureStore adapter for zustand/persist (non-sensitive app preferences).
// Failures degrade to in-memory defaults instead of surfacing as unhandled
// rejections — persistence is best-effort, the app must keep working.
const secureStorage = createJSONStorage(() => ({
  getItem: async (name: string) => {
    try {
      return await SecureStore.getItemAsync(name);
    } catch (err) {
      console.warn('[settingsStore] Failed to read persisted settings:', err);
      return null;
    }
  },
  setItem: async (name: string, value: string) => {
    try {
      await SecureStore.setItemAsync(name, value);
    } catch (err) {
      console.warn('[settingsStore] Failed to persist settings:', err);
    }
  },
  removeItem: async (name: string) => {
    try {
      await SecureStore.deleteItemAsync(name);
    } catch (err) {
      console.warn('[settingsStore] Failed to remove persisted settings:', err);
    }
  },
}));

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...ACCOUNT_DEFAULTS,
      themeMode: 'system',
      setSettings: (s) => set(s),
      // Resets every account-level preference to its fresh-install default,
      // keeping device-level ones (themeMode). Because this goes through
      // zustand's persist middleware, the persisted SecureStore copy is
      // rewritten with the defaults too — not just the in-memory state — so
      // the old account's preferences can't rehydrate for the next account.
      resetForSignOut: () => set({ ...ACCOUNT_DEFAULTS }),
    }),
    {
      // NOTE: SecureStore keys may only contain alphanumerics, ".", "-", "_".
      // The previous name 'convoy:settings' was rejected by SecureStore on every
      // write, so settings silently never persisted across cold starts.
      name: 'convoy.settings',
      storage: secureStorage,
      partialize: (state) => ({
        mapStyle: state.mapStyle,
        hazardAlertDistanceM: state.hazardAlertDistanceM,
        scenicRouting: state.scenicRouting,
        pttMaxSeconds: state.pttMaxSeconds,
        pttVolumePercent: state.pttVolumePercent,
        distanceUnit: state.distanceUnit,
        themeMode: state.themeMode,
        shareLocationWithFriends: state.shareLocationWithFriends,
      }),
    },
  ),
);
