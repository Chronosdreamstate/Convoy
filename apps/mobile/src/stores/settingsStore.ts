import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import * as SecureStore from 'expo-secure-store';

export type MapStyle = 'standard' | 'satellite' | 'hybrid';

interface SettingsState {
  mapStyle: MapStyle;
  hazardAlertDistanceM: number;
  scenicRouting: boolean;
  pttMaxSeconds: number;
  pttVolumePercent: number;
  setSettings: (s: Partial<Pick<SettingsState, 'mapStyle' | 'hazardAlertDistanceM' | 'scenicRouting' | 'pttMaxSeconds' | 'pttVolumePercent'>>) => void;
}

// SecureStore adapter for zustand/persist (non-sensitive app preferences)
const secureStorage = createJSONStorage(() => ({
  getItem: (name: string) => SecureStore.getItemAsync(name),
  setItem: (name: string, value: string) => SecureStore.setItemAsync(name, value),
  removeItem: (name: string) => SecureStore.deleteItemAsync(name),
}));

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      mapStyle: 'standard',
      hazardAlertDistanceM: 805,
      scenicRouting: false,
      pttMaxSeconds: 30,
      pttVolumePercent: 100,
      setSettings: (s) => set(s),
    }),
    {
      name: 'convoy:settings',
      storage: secureStorage,
      partialize: (state) => ({
        mapStyle: state.mapStyle,
        hazardAlertDistanceM: state.hazardAlertDistanceM,
        scenicRouting: state.scenicRouting,
        pttMaxSeconds: state.pttMaxSeconds,
        pttVolumePercent: state.pttVolumePercent,
      }),
    },
  ),
);
