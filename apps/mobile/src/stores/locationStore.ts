import { create } from 'zustand';

export interface MemberLocation {
  userId: string;
  lat: number;
  lng: number;
  heading: number;
  speedKph: number;
  /** Client-side wall-clock ms when this location was received */
  receivedAt: number;
  /** Timestamp the member device reported (ms) */
  ts: number;
}

interface LocationState {
  /** Keyed by userId — plain object for JSON-serializability */
  memberLocations: Record<string, MemberLocation>;
  /** Current user's own GPS position */
  myLocation: Omit<MemberLocation, 'userId'> | null;

  updateMemberLocation: (loc: MemberLocation) => void;
  removeMember: (userId: string) => void;
  updateMyLocation: (loc: Omit<MemberLocation, 'userId'>) => void;
  clearGroup: () => void;
  /** Remove entries whose receivedAt is older than staleMs */
  evictStale: (staleMs: number) => void;
}

export const useLocationStore = create<LocationState>((set) => ({
  memberLocations: {},
  myLocation: null,

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

  clearGroup: () => set({ memberLocations: {} }),

  evictStale: (staleMs) =>
    set((state) => {
      const now = Date.now();
      const next: Record<string, MemberLocation> = {};
      for (const [id, loc] of Object.entries(state.memberLocations)) {
        if (now - loc.receivedAt <= staleMs) next[id] = loc;
      }
      return { memberLocations: next };
    }),
}));
