import { create } from 'zustand';

interface GroupMeta {
  name: string | null;
  memberCount: number;
  adminId: string | null;
  leaderId: string | null;
  gapThresholdM: number;
  /** Admin-configured max PTT hold duration for THIS group (Req 10.5, 10.6, 16.3). */
  pttMaxSeconds: number;
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
const DEFAULT_PTT_MAX_SECONDS = 30; // Req 10.5 default

export const useGroupStore = create<GroupState>((set) => ({
  activeGroupId: null,
  pttChannelId: null,
  name: null,
  memberCount: 0,
  adminId: null,
  leaderId: null,
  gapThresholdM: DEFAULT_GAP_THRESHOLD_M,
  pttMaxSeconds: DEFAULT_PTT_MAX_SECONDS,
  setActiveGroupId: (activeGroupId) => set({ activeGroupId }),
  setPttChannelId: (pttChannelId) => set({ pttChannelId }),
  setGroupMeta: (meta) => set(meta),
  clearGroupMeta: () => set({ name: null, memberCount: 0, adminId: null, leaderId: null, gapThresholdM: DEFAULT_GAP_THRESHOLD_M, pttMaxSeconds: DEFAULT_PTT_MAX_SECONDS }),
  setLeader: (leaderId) => set({ leaderId }),
  /** Atomically clears all group state — use this instead of calling setActiveGroupId/setPttChannelId/clearGroupMeta separately. */
  leaveGroup: () =>
    set({ activeGroupId: null, pttChannelId: null, name: null, memberCount: 0, adminId: null, leaderId: null, gapThresholdM: DEFAULT_GAP_THRESHOLD_M, pttMaxSeconds: DEFAULT_PTT_MAX_SECONDS }),
}));
