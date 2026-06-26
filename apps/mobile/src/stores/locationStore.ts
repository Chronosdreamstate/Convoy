import { create } from 'zustand';

export interface MemberLocation {
  userId: string;
  displayName?: string;
  lat: number;
  lng: number;
  heading: number;
  speedKph: number;
  /** Client-side wall-clock ms when this location was received */
  receivedAt: number;
  /** Timestamp the member device reported (ms) */
  ts: number;
  /** True when this position was loaded from the offline cache (not a live update) */
  isStale?: boolean;
}

interface LocationState {
  /** Keyed by userId — plain object for JSON-serializability */
  memberLocations: Record<string, MemberLocation>;
  /** Current user's own GPS position */
  myLocation: Omit<MemberLocation, 'userId'> | null;
  /** Last-known positions loaded from the local cache after a disconnect */
  stalePositions: Record<string, MemberLocation>;

  updateMemberLocation: (loc: MemberLocation) => void;
  removeMember: (userId: string) => void;
  updateMyLocation: (loc: Omit<MemberLocation, 'userId'>) => void;
  clearGroup: () => void;
  /** Remove entries whose receivedAt is older than staleMs */
  evictStale: (staleMs: number) => void;
  /** Overwrite stalePositions with positions loaded from the offline cache */
  setStalePositions: (positions: MemberLocation[]) => void;
  /** Clear stale positions (called on reconnect) */
  clearStalePositions: () => void;
}

export const useLocationStore = create<LocationState>((set) => ({
  memberLocations: {},
  myLocation: null,
  stalePositions: {},

  updateMemberLocation: (loc) =>
    set((state) => ({
      memberLocations: { ...state.memberLocations, [loc.userId]: loc },
    })),

  removeMember: (userId) =>
    set((state) => {
      const { [userId]: _, ...rest } = state.memberLocations;
      return { memberLocations: rest };
    }),

  updateMyLocation: (loc) => set({ myLocation: loc }),

  clearGroup: () => set({ memberLocations: {}, stalePositions: {}, myLocation: null }),

  evictStale: (staleMs) =>
    set((state) => {
      const now = Date.now();
      const next: Record<string, MemberLocation> = {};
      for (const [id, loc] of Object.entries(state.memberLocations)) {
        if (now - loc.receivedAt <= staleMs) next[id] = loc;
      }
      return { memberLocations: next };
    }),

  setStalePositions: (positions) => {
    const map: Record<string, MemberLocation> = {};
    for (const p of positions) {
      map[p.userId] = { ...p, isStale: true };
    }
    set({ stalePositions: map });
  },

  clearStalePositions: () => set({ stalePositions: {} }),
}));
