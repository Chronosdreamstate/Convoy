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
  /** Keyed by userId */
  memberLocations: Map<string, MemberLocation>;
  /** Current user's own GPS position */
  myLocation: Omit<MemberLocation, 'userId'> | null;

  updateMemberLocation: (loc: MemberLocation) => void;
  removeMember: (userId: string) => void;
  updateMyLocation: (loc: Omit<MemberLocation, 'userId'>) => void;
  clearGroup: () => void;
}

export const useLocationStore = create<LocationState>((set) => ({
  memberLocations: new Map(),
  myLocation: null,

  updateMemberLocation: (loc) =>
    set((state) => {
      const next = new Map(state.memberLocations);
      next.set(loc.userId, loc);
      return { memberLocations: next };
    }),

  removeMember: (userId) =>
    set((state) => {
      const next = new Map(state.memberLocations);
      next.delete(userId);
      return { memberLocations: next };
    }),

  updateMyLocation: (loc) => set({ myLocation: loc }),

  clearGroup: () => set({ memberLocations: new Map() }),
}));
