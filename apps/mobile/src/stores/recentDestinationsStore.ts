import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import * as SecureStore from 'expo-secure-store';

export interface RecentDestination {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
}

interface RecentDestinationsState {
  destinations: RecentDestination[];
  addDestination: (d: RecentDestination) => void;
  clearDestinations: () => void;
}

// Failures degrade to in-memory state instead of surfacing as unhandled
// rejections — persistence is best-effort, the app must keep working.
const secureStorage = createJSONStorage(() => ({
  getItem: async (name: string) => {
    try {
      return await SecureStore.getItemAsync(name);
    } catch (err) {
      console.warn('[recentDestinationsStore] Failed to read persisted recents:', err);
      return null;
    }
  },
  setItem: async (name: string, value: string) => {
    try {
      await SecureStore.setItemAsync(name, value);
    } catch (err) {
      console.warn('[recentDestinationsStore] Failed to persist recents:', err);
    }
  },
  removeItem: async (name: string) => {
    try {
      await SecureStore.deleteItemAsync(name);
    } catch (err) {
      console.warn('[recentDestinationsStore] Failed to remove persisted recents:', err);
    }
  },
}));

export const MAX_RECENT = 5;

/** Pure reducer — exported for property testing. */
export function applyAddDestination(
  destinations: RecentDestination[],
  d: RecentDestination,
): RecentDestination[] {
  const filtered = destinations.filter((r) => r.id !== d.id);
  return [d, ...filtered].slice(0, MAX_RECENT);
}

export const useRecentDestinationsStore = create<RecentDestinationsState>()(
  persist(
    (set) => ({
      destinations: [],
      addDestination: (d) =>
        set((state) => ({ destinations: applyAddDestination(state.destinations, d) })),
      clearDestinations: () => set({ destinations: [] }),
    }),
    {
      // NOTE: SecureStore keys may only contain alphanumerics, ".", "-", "_".
      // The previous name 'convoy:recent-destinations' was rejected by SecureStore
      // on every write, so recents silently never persisted across cold starts.
      name: 'convoy.recent-destinations',
      storage: secureStorage,
      partialize: (state) => ({ destinations: state.destinations }),
    },
  ),
);
