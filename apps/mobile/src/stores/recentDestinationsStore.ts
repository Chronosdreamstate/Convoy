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

const secureStorage = createJSONStorage(() => ({
  getItem: (name: string) => SecureStore.getItemAsync(name),
  setItem: (name: string, value: string) => SecureStore.setItemAsync(name, value),
  removeItem: (name: string) => SecureStore.deleteItemAsync(name),
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
      name: 'convoy:recent-destinations',
      storage: secureStorage,
      partialize: (state) => ({ destinations: state.destinations }),
    },
  ),
);
