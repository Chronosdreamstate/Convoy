/**
 * Unit tests for the group store (active convoy group + PTT metadata).
 *
 * Covers:
 *  - Defaults: gapThresholdM = 3219 (2 miles), pttMaxSeconds = 30 (Req 10.5)
 *  - setGroupMeta performs partial updates only
 *  - clearGroupMeta restores meta defaults but keeps activeGroupId/pttChannelId
 *  - leaveGroup atomically resets ALL group state including ids
 *  - setLeader updates leaderId only
 */

import { useGroupStore } from './groupStore';

const DEFAULTS = {
  activeGroupId: null,
  pttChannelId: null,
  assignedPttChannelId: null,
  name: null,
  memberCount: 0,
  adminId: null,
  leaderId: null,
  gapThresholdM: 3219,
  pttMaxSeconds: 30,
};

function resetStore() {
  useGroupStore.setState({ ...DEFAULTS });
}

beforeEach(resetStore);

describe('defaults', () => {
  it('starts with documented default gap threshold and PTT hold limit', () => {
    const s = useGroupStore.getState();
    expect(s.gapThresholdM).toBe(3219);
    expect(s.pttMaxSeconds).toBe(30);
    expect(s.activeGroupId).toBeNull();
    expect(s.leaderId).toBeNull();
  });
});

describe('setGroupMeta', () => {
  it('applies partial updates without clobbering unspecified fields', () => {
    useGroupStore.getState().setGroupMeta({ name: 'Canyon Run', memberCount: 7 });
    useGroupStore.getState().setGroupMeta({ pttMaxSeconds: 15 });

    const s = useGroupStore.getState();
    expect(s.name).toBe('Canyon Run');
    expect(s.memberCount).toBe(7);
    expect(s.pttMaxSeconds).toBe(15);
    expect(s.gapThresholdM).toBe(3219); // untouched default
  });
});

describe('setLeader', () => {
  it('updates leaderId and nothing else', () => {
    useGroupStore.getState().setGroupMeta({ adminId: 'admin-1', name: 'G' });
    useGroupStore.getState().setLeader('leader-9');

    const s = useGroupStore.getState();
    expect(s.leaderId).toBe('leader-9');
    expect(s.adminId).toBe('admin-1');
    expect(s.name).toBe('G');
  });
});

describe('clearGroupMeta', () => {
  it('restores meta defaults but preserves activeGroupId and pttChannelId', () => {
    const s0 = useGroupStore.getState();
    s0.setActiveGroupId('g-1');
    s0.setPttChannelId('ptt-1');
    s0.setGroupMeta({
      name: 'X', memberCount: 3, adminId: 'a', leaderId: 'l',
      gapThresholdM: 100, pttMaxSeconds: 10,
    });

    useGroupStore.getState().clearGroupMeta();

    const s = useGroupStore.getState();
    expect(s.name).toBeNull();
    expect(s.memberCount).toBe(0);
    expect(s.adminId).toBeNull();
    expect(s.leaderId).toBeNull();
    expect(s.gapThresholdM).toBe(3219);
    expect(s.pttMaxSeconds).toBe(30);
    // ids intentionally survive clearGroupMeta
    expect(s.activeGroupId).toBe('g-1');
    expect(s.pttChannelId).toBe('ptt-1');
  });
});

describe('applyAssignedPttChannel (Req 26.3)', () => {
  it('moves this device to the Admin-assigned channel and queues the notice', () => {
    useGroupStore.setState({ activeGroupId: 'g-1', pttChannelId: 'all' });

    useGroupStore.getState().applyAssignedPttChannel('g-1', 'lead');

    const s = useGroupStore.getState();
    expect(s.pttChannelId).toBe('lead');
    expect(s.assignedPttChannelId).toBe('lead');
  });

  it('ignores an assignment addressed to a different group', () => {
    // The push is addressed to the user, so a stale convoy's assignment can
    // still arrive — honouring it would hijack the live PTT session.
    useGroupStore.setState({ activeGroupId: 'g-1', pttChannelId: 'all' });

    useGroupStore.getState().applyAssignedPttChannel('g-2', 'lead');

    expect(useGroupStore.getState().pttChannelId).toBe('all');
    expect(useGroupStore.getState().assignedPttChannelId).toBeNull();
  });

  it('is a no-op when already on the assigned channel (no spurious announcement)', () => {
    useGroupStore.setState({ activeGroupId: 'g-1', pttChannelId: 'lead' });

    useGroupStore.getState().applyAssignedPttChannel('g-1', 'lead');

    expect(useGroupStore.getState().assignedPttChannelId).toBeNull();
  });

  it('clearAssignedPttChannelNotice leaves the channel itself in place', () => {
    useGroupStore.setState({ activeGroupId: 'g-1', pttChannelId: 'all' });
    useGroupStore.getState().applyAssignedPttChannel('g-1', 'lead');

    useGroupStore.getState().clearAssignedPttChannelNotice();

    expect(useGroupStore.getState().assignedPttChannelId).toBeNull();
    expect(useGroupStore.getState().pttChannelId).toBe('lead');
  });
});

describe('leaveGroup', () => {
  it('atomically resets every field to defaults, including group and PTT ids', () => {
    const s0 = useGroupStore.getState();
    s0.setActiveGroupId('g-1');
    s0.setPttChannelId('ptt-1');
    s0.applyAssignedPttChannel('g-1', 'ptt-2');
    s0.setGroupMeta({
      name: 'X', memberCount: 3, adminId: 'a', leaderId: 'l',
      gapThresholdM: 100, pttMaxSeconds: 10,
    });

    useGroupStore.getState().leaveGroup();

    expect(useGroupStore.getState()).toMatchObject(DEFAULTS);
  });
});

describe('setActiveGroupId — group switch (leave X, join Y)', () => {
  it('drops the previous convoy\'s PTT channel and settings when switching groups', () => {
    // Convoy X: on a sub-channel, with the Admin's own gap/hold settings.
    const s0 = useGroupStore.getState();
    s0.setActiveGroupId('group-X');
    s0.setPttChannelId('chan-X-lead');
    s0.applyAssignedPttChannel('group-X', 'chan-X-lead2');
    s0.setGroupMeta({
      name: 'Canyon Run', memberCount: 6, adminId: 'admin-X', leaderId: 'lead-X',
      gapThresholdM: 100, pttMaxSeconds: 15,
    });

    // JoinByCodeScreen / CreateGroupScreen switch straight from X to Y: they
    // set the id and then only name+adminId, never passing through null.
    useGroupStore.getState().setActiveGroupId('group-Y');

    const s = useGroupStore.getState();
    expect(s.activeGroupId).toBe('group-Y');
    // app/(tabs)/map.tsx feeds pttChannelId straight into PTTService.joinChannel
    // and `ptt:start` — carrying X's channel into Y kills (or misroutes) voice.
    expect(s.pttChannelId).toBeNull();
    expect(s.assignedPttChannelId).toBeNull();
    expect(s.name).toBeNull();
    expect(s.memberCount).toBe(0);
    expect(s.adminId).toBeNull();
    expect(s.leaderId).toBeNull();
    expect(s.gapThresholdM).toBe(3219);
    expect(s.pttMaxSeconds).toBe(30);
  });

  it('leaves state untouched when re-setting the SAME group id', () => {
    // ConvoyScreen's sync effect re-runs on every memberCount/name change and
    // re-sets the same id — that must not bounce the live PTT session.
    const s0 = useGroupStore.getState();
    s0.setActiveGroupId('group-X');
    s0.setPttChannelId('chan-X-lead');
    s0.setGroupMeta({ name: 'Canyon Run', gapThresholdM: 100 });

    useGroupStore.getState().setActiveGroupId('group-X');

    const s = useGroupStore.getState();
    expect(s.pttChannelId).toBe('chan-X-lead');
    expect(s.name).toBe('Canyon Run');
    expect(s.gapThresholdM).toBe(100);
  });

  it('leaves state untouched when clearing to null (ConvoyScreen mount transient)', () => {
    // ConvoyScreen momentarily pushes null on mount before its group loads;
    // screens clear group state explicitly via leaveGroup/clearGroupMeta.
    const s0 = useGroupStore.getState();
    s0.setActiveGroupId('group-X');
    s0.setPttChannelId('chan-X-lead');

    useGroupStore.getState().setActiveGroupId(null);

    const s = useGroupStore.getState();
    expect(s.activeGroupId).toBeNull();
    expect(s.pttChannelId).toBe('chan-X-lead');
  });

  it('adopts the first group normally (null → X keeps meta set alongside it)', () => {
    // CreateGroupScreen sets the id and then name/adminId; a reset triggered
    // by null → X would be harmless but must not fire before those writes.
    useGroupStore.getState().setActiveGroupId('group-X');
    useGroupStore.getState().setGroupMeta({ name: 'New Convoy', adminId: 'me' });

    const s = useGroupStore.getState();
    expect(s.activeGroupId).toBe('group-X');
    expect(s.name).toBe('New Convoy');
    expect(s.adminId).toBe('me');
  });
});
