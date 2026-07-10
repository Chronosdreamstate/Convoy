/**
 * Unit tests for the location store (member positions on the group map).
 *
 * Covers:
 *  - updateMemberLocation upserts by userId without disturbing other members
 *  - removeMember deletes only the targeted member
 *  - evictStale keeps entries at exactly the staleness boundary and evicts older
 *  - setStalePositions marks every entry isStale and keys by userId
 *  - clearGroup / clearStalePositions reset the right slices of state
 */

import { useLocationStore, MemberLocation } from './locationStore';

function makeLoc(userId: string, overrides: Partial<MemberLocation> = {}): MemberLocation {
  return {
    userId,
    displayName: `User ${userId}`,
    lat: 37.77,
    lng: -122.41,
    heading: 90,
    speedKph: 50,
    receivedAt: Date.now(),
    ts: Date.now(),
    ...overrides,
  };
}

function resetStore() {
  useLocationStore.setState({
    memberLocations: {},
    myLocation: null,
    stalePositions: {},
  });
}

beforeEach(() => {
  resetStore();
  jest.restoreAllMocks();
});

describe('updateMemberLocation', () => {
  it('adds a new member keyed by userId', () => {
    const loc = makeLoc('u1');
    useLocationStore.getState().updateMemberLocation(loc);
    expect(useLocationStore.getState().memberLocations).toEqual({ u1: loc });
  });

  it('overwrites an existing member without touching others', () => {
    const { updateMemberLocation } = useLocationStore.getState();
    updateMemberLocation(makeLoc('u1', { lat: 1 }));
    updateMemberLocation(makeLoc('u2', { lat: 2 }));
    updateMemberLocation(makeLoc('u1', { lat: 99 }));

    const state = useLocationStore.getState();
    expect(Object.keys(state.memberLocations).sort()).toEqual(['u1', 'u2']);
    expect(state.memberLocations.u1.lat).toBe(99);
    expect(state.memberLocations.u2.lat).toBe(2);
  });
});

describe('removeMember', () => {
  it('removes only the targeted member', () => {
    const { updateMemberLocation } = useLocationStore.getState();
    updateMemberLocation(makeLoc('u1'));
    updateMemberLocation(makeLoc('u2'));

    useLocationStore.getState().removeMember('u1');

    const state = useLocationStore.getState();
    expect(state.memberLocations.u1).toBeUndefined();
    expect(state.memberLocations.u2).toBeDefined();
  });

  it('is a no-op for an unknown userId', () => {
    useLocationStore.getState().updateMemberLocation(makeLoc('u1'));
    useLocationStore.getState().removeMember('ghost');
    expect(Object.keys(useLocationStore.getState().memberLocations)).toEqual(['u1']);
  });
});

describe('evictStale', () => {
  it('keeps entries exactly at the staleness boundary and evicts older ones', () => {
    const NOW = 1_000_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const staleMs = 30_000;

    const { updateMemberLocation } = useLocationStore.getState();
    updateMemberLocation(makeLoc('fresh', { receivedAt: NOW - 1_000 }));
    updateMemberLocation(makeLoc('boundary', { receivedAt: NOW - staleMs })); // == staleMs -> kept
    updateMemberLocation(makeLoc('stale', { receivedAt: NOW - staleMs - 1 })); // > staleMs -> evicted

    useLocationStore.getState().evictStale(staleMs);

    const ids = Object.keys(useLocationStore.getState().memberLocations).sort();
    expect(ids).toEqual(['boundary', 'fresh']);
  });

  it('evicting from an empty store leaves it empty', () => {
    useLocationStore.getState().evictStale(1000);
    expect(useLocationStore.getState().memberLocations).toEqual({});
  });
});

describe('setStalePositions / clearStalePositions', () => {
  it('marks every loaded position isStale and keys the map by userId', () => {
    const positions = [
      makeLoc('u1', { isStale: undefined }),
      makeLoc('u2', { isStale: false }),
    ];
    useLocationStore.getState().setStalePositions(positions);

    const { stalePositions } = useLocationStore.getState();
    expect(Object.keys(stalePositions).sort()).toEqual(['u1', 'u2']);
    expect(stalePositions.u1.isStale).toBe(true);
    expect(stalePositions.u2.isStale).toBe(true);
  });

  it('overwrites previous stale positions entirely', () => {
    useLocationStore.getState().setStalePositions([makeLoc('old')]);
    useLocationStore.getState().setStalePositions([makeLoc('new')]);

    expect(Object.keys(useLocationStore.getState().stalePositions)).toEqual(['new']);
  });

  it('clearStalePositions empties only stale positions, not live ones', () => {
    useLocationStore.getState().updateMemberLocation(makeLoc('live'));
    useLocationStore.getState().setStalePositions([makeLoc('cached')]);

    useLocationStore.getState().clearStalePositions();

    const state = useLocationStore.getState();
    expect(state.stalePositions).toEqual({});
    expect(state.memberLocations.live).toBeDefined();
  });
});

describe('clearGroup', () => {
  it('resets member locations, stale positions, and my location', () => {
    const store = useLocationStore.getState();
    store.updateMemberLocation(makeLoc('u1'));
    store.setStalePositions([makeLoc('u2')]);
    store.updateMyLocation({
      lat: 1, lng: 2, heading: 3, speedKph: 4, receivedAt: 5, ts: 6,
    });

    useLocationStore.getState().clearGroup();

    const state = useLocationStore.getState();
    expect(state.memberLocations).toEqual({});
    expect(state.stalePositions).toEqual({});
    expect(state.myLocation).toBeNull();
  });
});
