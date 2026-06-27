import { create } from 'zustand';

interface GroupMeta {
  name: string | null;
  memberCount: number;
  adminId: string | null;
  leaderId: string | null;
}

interface GroupState extends GroupMeta {
  activeGroupId: string | null;
  pttChannelId: string | null;
  setActiveGroupId: (id: string | null) => void;
  setPttChannelId: (id: string | null) => void;
  setGroupMeta: (meta: Partial<GroupMeta>) => void;
  clearGroupMeta: () => void;
  setLeader: (userId: string) => void;
  leaveGroup: () => void;
}

export const useGroupStore = create<GroupState>((set) => ({
  activeGroupId: null,
  pttChannelId: null,
  name: null,
  memberCount: 0,
  adminId: null,
  leaderId: null,
  setActiveGroupId: (activeGroupId) => set({ activeGroupId }),
  setPttChannelId: (pttChannelId) => set({ pttChannelId }),
  setGroupMeta: (meta) => set(meta),
  clearGroupMeta: () => set({ name: null, memberCount: 0, adminId: null, leaderId: null }),
  setLeader: (leaderId) => set({ leaderId }),
  /** Atomically clears all group state — use this instead of calling setActiveGroupId/setPttChannelId/clearGroupMeta separately. */
  leaveGroup: () =>
    set({ activeGroupId: null, pttChannelId: null, name: null, memberCount: 0, adminId: null, leaderId: null }),
}));
