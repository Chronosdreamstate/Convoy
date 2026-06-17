import { create } from 'zustand';

interface GroupState {
  activeGroupId: string | null;
  setActiveGroupId: (id: string | null) => void;
}

export const useGroupStore = create<GroupState>((set) => ({
  activeGroupId: null,
  setActiveGroupId: (activeGroupId) => set({ activeGroupId }),
}));
