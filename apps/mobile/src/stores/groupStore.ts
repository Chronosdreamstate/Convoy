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

/**
 * Every field in this store that describes ONE convoy. Wiped whenever the
 * active group id changes to a different convoy, so nothing recorded for the
 * previous one can be read as if it described the new one.
 */
const GROUP_SCOPED_DEFAULTS = {
  pttChannelId: null as string | null,
  assignedPttChannelId: null as string | null,
  name: null as string | null,
  memberCount: 0,
  adminId: null as string | null,
  leaderId: null as string | null,
  gapThresholdM: DEFAULT_GAP_THRESHOLD_M,
  pttMaxSeconds: DEFAULT_PTT_MAX_SECONDS,
};

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
  // Moving straight from one convoy to another (JoinByCodeScreen and
  // CreateGroupScreen both call this then setGroupMeta with only name/adminId,
  // without the group ever passing through null) must not carry the previous
  // convoy's group-scoped state over. It used to: `pttChannelId` in particular
  // is handed to MapScreen by app/(tabs)/map.tsx and fed straight into
  // PTTService.joinChannel / `ptt:start`, so the new convoy asked for a token
  // on the OLD convoy's channel — voice dead (or worse, routed to the wrong
  // convoy) for the whole session. gapThresholdM/pttMaxSeconds leaked the same
  // way, driving gap alerts and the PTT hold cap off the old Admin's settings.
  //
  // Only a real group→group switch resets. Clearing on `null` too would fire
  // on ConvoyScreen's mount, whose sync effect momentarily pushes null before
  // its group loads — that would bounce a live PTT session off its channel.
  setActiveGroupId: (activeGroupId) =>
    set((state) =>
      activeGroupId !== null &&
      state.activeGroupId !== null &&
      state.activeGroupId !== activeGroupId
        ? { activeGroupId, ...GROUP_SCOPED_DEFAULTS }
        : { activeGroupId },
    ),
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
  leaveGroup: () => set({ activeGroupId: null, ...GROUP_SCOPED_DEFAULTS }),
}));
