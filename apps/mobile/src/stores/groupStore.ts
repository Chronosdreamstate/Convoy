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
  /**
   * Channel this device was just MOVED to by the Admin (Req 26.3), pending an
   * on-screen announcement. Set by the socket layer, cleared once the UI has
   * told the user — a silent channel switch would leave them talking to people
   * who can't hear them.
   */
  assignedPttChannelId: string | null;
  setActiveGroupId: (id: string | null) => void;
  setPttChannelId: (id: string | null) => void;
  /** Apply an Admin's `ptt:channel_assigned` push for `groupId`. */
  applyAssignedPttChannel: (groupId: string, channelId: string) => void;
  clearAssignedPttChannelNotice: () => void;
  setGroupMeta: (meta: Partial<GroupMeta>) => void;
  clearGroupMeta: () => void;
  setLeader: (userId: string) => void;
  leaveGroup: () => void;
}

const DEFAULT_GAP_THRESHOLD_M = 3219;
const DEFAULT_PTT_MAX_SECONDS = 30; // Req 10.5 default

export const useGroupStore = create<GroupState>((set, get) => ({
  activeGroupId: null,
  pttChannelId: null,
  assignedPttChannelId: null,
  name: null,
  memberCount: 0,
  adminId: null,
  leaderId: null,
  gapThresholdM: DEFAULT_GAP_THRESHOLD_M,
  pttMaxSeconds: DEFAULT_PTT_MAX_SECONDS,
  setActiveGroupId: (activeGroupId) => set({ activeGroupId }),
  setPttChannelId: (pttChannelId) => set({ pttChannelId }),
  // The push is addressed to the USER, not to a group room, so it can arrive
  // for a convoy this device already left (or one it was never showing) —
  // switching channels then would hijack the live PTT session for the wrong
  // group. Only the active group's assignment is honoured.
  applyAssignedPttChannel: (groupId, channelId) => {
    const { activeGroupId, pttChannelId } = get();
    if (activeGroupId !== groupId || pttChannelId === channelId) return;
    set({ pttChannelId: channelId, assignedPttChannelId: channelId });
  },
  clearAssignedPttChannelNotice: () => set({ assignedPttChannelId: null }),
  setGroupMeta: (meta) => set(meta),
  clearGroupMeta: () => set({ name: null, memberCount: 0, adminId: null, leaderId: null, gapThresholdM: DEFAULT_GAP_THRESHOLD_M, pttMaxSeconds: DEFAULT_PTT_MAX_SECONDS }),
  setLeader: (leaderId) => set({ leaderId }),
  /** Atomically clears all group state — use this instead of calling setActiveGroupId/setPttChannelId/clearGroupMeta separately. */
  leaveGroup: () =>
    set({ activeGroupId: null, pttChannelId: null, assignedPttChannelId: null, name: null, memberCount: 0, adminId: null, leaderId: null, gapThresholdM: DEFAULT_GAP_THRESHOLD_M, pttMaxSeconds: DEFAULT_PTT_MAX_SECONDS }),
}));
