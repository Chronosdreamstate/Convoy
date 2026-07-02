import { create } from 'zustand';

interface GroupMeta {
  name: string | null;
  memberCount: number;
  adminId: string | null;
  leaderId: string | null;
  gapThresholdM: number;
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

const DEFAULT_GAP_THRESHOLD_M = 3219;

export const useGroupStore = create<GroupState>((set) => ({
  activeGroupId: null,
  pttChannelId: null,
  name: null,
  memberCount: 0,
  adminId: null,
  leaderId: null,
  gapThresholdM: DEFAULT_GAP_THRESHOLD_M,
  setActiveGroupId: (activeGroupId) => set({ activeGroupId }),
  setPttChannelId: (pttChannelId) => set({ pttChannelId }),
  setGroupMeta: (meta) => set(meta),
  clearGroupMeta: () => set({ name: null, memberCount: 0, adminId: null, leaderId: null, gapThresholdM: DEFAULT_GAP_THRESHOLD_M }),
  setLeader: (leaderId) => set({ leaderId }),
  /** Atomically clears all group state — use this instead of calling setActiveGroupId/setPttChannelId/clearGroupMeta separately. */
  leaveGroup: () =>
    set({ activeGroupId: null, pttChannelId: null, name: null, memberCount: 0, adminId: null, leaderId: null, gapThresholdM: DEFAULT_GAP_THRESHOLD_M }),
}));
