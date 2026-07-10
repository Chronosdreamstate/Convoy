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
}

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
      mapStyle: 'standard',
      hazardAlertDistanceM: 805,
      scenicRouting: false,
      pttMaxSeconds: 30,
      pttVolumePercent: 100,
      distanceUnit: 'miles',
      themeMode: 'system',
      shareLocationWithFriends: false,
      setSettings: (s) => set(s),
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
