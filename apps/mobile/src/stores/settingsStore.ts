import { create } from 'zustand';

export type MapStyle = 'standard' | 'satellite' | 'hybrid';

interface SettingsState {
  mapStyle: MapStyle;
  hazardAlertDistanceM: number;
  scenicRouting: boolean;
  setSettings: (s: Partial<Pick<SettingsState, 'mapStyle' | 'hazardAlertDistanceM' | 'scenicRouting'>>) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  mapStyle: 'standard',
  hazardAlertDistanceM: 805,
  scenicRouting: false,
  setSettings: (s) => set(s),
}));
