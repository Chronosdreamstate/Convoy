import { create } from 'zustand';

export type MapStyle = 'standard' | 'satellite' | 'hybrid';

interface SettingsState {
  mapStyle: MapStyle;
  hazardAlertDistanceM: number;
  scenicRouting: boolean;
  pttMaxSeconds: number;
  setSettings: (s: Partial<Pick<SettingsState, 'mapStyle' | 'hazardAlertDistanceM' | 'scenicRouting' | 'pttMaxSeconds'>>) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  mapStyle: 'standard',
  hazardAlertDistanceM: 805,
  scenicRouting: false,
  pttMaxSeconds: 30,
  setSettings: (s) => set(s),
}));
