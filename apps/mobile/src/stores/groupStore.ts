import { create } from 'zustand';

interface GroupState {
  activeGroupId: string | null;
  pttChannelId: string | null;
  setActiveGroupId: (id: string | null) => void;
  setPttChannelId: (id: string | null) => void;
}

export const useGroupStore = create<GroupState>((set) => ({
  activeGroupId: null,
  pttChannelId: null,
  setActiveGroupId: (activeGroupId) => set({ activeGroupId }),
  setPttChannelId: (pttChannelId) => set({ pttChannelId }),
}));
