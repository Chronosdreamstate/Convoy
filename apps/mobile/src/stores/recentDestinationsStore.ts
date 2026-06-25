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

const MAX_RECENT = 5;

export const useRecentDestinationsStore = create<RecentDestinationsState>()(
  persist(
    (set) => ({
      destinations: [],
      addDestination: (d) =>
        set((state) => {
          const filtered = state.destinations.filter((r) => r.id !== d.id);
          return { destinations: [d, ...filtered].slice(0, MAX_RECENT) };
        }),
      clearDestinations: () => set({ destinations: [] }),
    }),
    {
      name: 'convoy:recent-destinations',
      storage: secureStorage,
      partialize: (state) => ({ destinations: state.destinations }),
    },
  ),
);
