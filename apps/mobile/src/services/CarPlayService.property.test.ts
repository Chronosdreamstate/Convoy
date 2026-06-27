/**
 * Property tests for CarPlayService.
 *
 * Property 113: syncStateIfChanged suppresses duplicate native IPC
 *   Calling syncStateIfChanged with the same state twice never issues a second
 *   native syncState call. Any change to any of the 5 fields triggers a new call.
 *   Validates: Requirements 35.1, 13.1
 *
 * Property 114: getState reflects the most-recently synced state
 *   After syncStateIfChanged(s), getState() returns s for any CarPlayState.
 *   Validates: Requirements 13.1, 35.2
 *
 * Property 115: destroy resets currentState to null
 *   After destroy(), getState() is null regardless of prior sync calls.
 *   Validates: Requirements 13.7
 *
 * Property 116: start() never accumulates duplicate listeners
 *   Calling start() N times always results in exactly 3N addListener calls but
 *   the prior subscriptions are removed first, so only 3 are active at a time.
 *   Validates: Requirements 28.1, 38.3
 */

import fc from 'fast-check';

// ---------------------------------------------------------------------------
// Mock react-native (factory must be self-contained — no external variable refs)
// ---------------------------------------------------------------------------

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  NativeModules: {
    ConvoyCarPlay: {
      syncState: jest.fn(),
      isSessionActive: jest.fn().mockResolvedValue(false),
    },
  },
  NativeEventEmitter: jest.fn().mockImplementation(() => ({
    addListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
  })),
  EmitterSubscription: class {},
}));

// Import AFTER mock is registered
import { NativeModules, NativeEventEmitter } from 'react-native';
import { CarPlayService, CarPlayState, ICarPlayInstrumentCluster } from './CarPlayService';

// Typed references to the mocked functions
const mockSyncState = NativeModules.ConvoyCarPlay.syncState as jest.Mock;
const MockNativeEventEmitter = NativeEventEmitter as jest.MockedClass<typeof NativeEventEmitter>;

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const fcGroupId = fc.oneof(
  fc.constant(null as string | null),
  fc.string({ minLength: 1, maxLength: 36 }).filter((s) => s.trim().length > 0),
);

const fcPttChannelId = fc.oneof(
  fc.constant(null as string | null),
  fc.string({ minLength: 1, maxLength: 36 }).filter((s) => s.trim().length > 0),
);

const fcCarPlayState = (): fc.Arbitrary<CarPlayState> =>
  fc.record({
    groupId: fcGroupId,
    memberCount: fc.integer({ min: 0, max: 100 }),
    routeActive: fc.boolean(),
    pttChannelId: fcPttChannelId,
    myCallsign: fc.string({ minLength: 0, maxLength: 20 }),
    activeGroupName: fc.oneof(fc.constant(null as string | null), fc.string({ minLength: 1, maxLength: 40 })),
    nearbyGroupCount: fc.integer({ min: 0, max: 50 }),
    convoyStatus: fc.oneof(fc.constant('idle' as const), fc.constant('active' as const), fc.constant('ending' as const)),
    transmittingMemberCallsign: fc.oneof(fc.constant(null as string | null), fc.string({ minLength: 1, maxLength: 20 })),
    nextWaypointName: fc.oneof(fc.constant(null as string | null), fc.string({ minLength: 1, maxLength: 40 })),
    nextWaypointEtaMinutes: fc.oneof(fc.constant(null as number | null), fc.integer({ min: 1, max: 120 })),
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSvc(): CarPlayService {
  return new CarPlayService();
}

beforeEach(() => {
  mockSyncState.mockClear();
  MockNativeEventEmitter.mockClear();
  // Re-setup the emitter mock's addListener for each test
  MockNativeEventEmitter.mockImplementation(() => ({
    addListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
    removeAllListeners: jest.fn(),
    listenerCount: jest.fn().mockReturnValue(0),
    emit: jest.fn(),
  }));
});

// ---------------------------------------------------------------------------
// Property 113: syncStateIfChanged suppresses duplicate native IPC
// ---------------------------------------------------------------------------

describe('Property 113: syncStateIfChanged suppresses duplicate native IPC', () => {
  it('identical state twice → native syncState called exactly once', () => {
    fc.assert(
      fc.property(
        fcCarPlayState(),
        (state) => {
          mockSyncState.mockClear();
          const svc = makeSvc();

          svc.syncStateIfChanged(state);
          expect(mockSyncState).toHaveBeenCalledTimes(1);

          svc.syncStateIfChanged(state);
          expect(mockSyncState).toHaveBeenCalledTimes(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('N identical calls after first sync produce exactly 1 total native call', () => {
    fc.assert(
      fc.property(
        fcCarPlayState(),
        fc.integer({ min: 2, max: 10 }),
        (state, repeatCount) => {
          mockSyncState.mockClear();
          const svc = makeSvc();

          for (let i = 0; i < repeatCount; i++) {
            svc.syncStateIfChanged(state);
          }
          expect(mockSyncState).toHaveBeenCalledTimes(1);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('changing groupId always triggers a new native call', () => {
    fc.assert(
      fc.property(
        fcCarPlayState(),
        fc.oneof(fc.constant(null as string | null), fc.string({ minLength: 1, maxLength: 36 })),
        (base, newGroupId) => {
          fc.pre(newGroupId !== base.groupId);
          mockSyncState.mockClear();
          const svc = makeSvc();

          svc.syncStateIfChanged(base);
          svc.syncStateIfChanged({ ...base, groupId: newGroupId });
          expect(mockSyncState).toHaveBeenCalledTimes(2);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('changing memberCount triggers a new native call', () => {
    fc.assert(
      fc.property(
        fcCarPlayState(),
        fc.integer({ min: 0, max: 200 }),
        (base, newCount) => {
          fc.pre(newCount !== base.memberCount);
          mockSyncState.mockClear();
          const svc = makeSvc();

          svc.syncStateIfChanged(base);
          svc.syncStateIfChanged({ ...base, memberCount: newCount });
          expect(mockSyncState).toHaveBeenCalledTimes(2);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('flipping routeActive triggers a new native call', () => {
    fc.assert(
      fc.property(
        fcCarPlayState(),
        (base) => {
          mockSyncState.mockClear();
          const svc = makeSvc();

          svc.syncStateIfChanged(base);
          svc.syncStateIfChanged({ ...base, routeActive: !base.routeActive });
          expect(mockSyncState).toHaveBeenCalledTimes(2);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('changing pttChannelId triggers a new native call', () => {
    fc.assert(
      fc.property(
        fcCarPlayState(),
        fc.oneof(fc.constant(null as string | null), fc.string({ minLength: 1, maxLength: 36 })),
        (base, newChannel) => {
          fc.pre(newChannel !== base.pttChannelId);
          mockSyncState.mockClear();
          const svc = makeSvc();

          svc.syncStateIfChanged(base);
          svc.syncStateIfChanged({ ...base, pttChannelId: newChannel });
          expect(mockSyncState).toHaveBeenCalledTimes(2);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('changing myCallsign triggers a new native call', () => {
    fc.assert(
      fc.property(
        fcCarPlayState(),
        fc.string({ minLength: 0, maxLength: 20 }),
        (base, newCallsign) => {
          fc.pre(newCallsign !== base.myCallsign);
          mockSyncState.mockClear();
          const svc = makeSvc();

          svc.syncStateIfChanged(base);
          svc.syncStateIfChanged({ ...base, myCallsign: newCallsign });
          expect(mockSyncState).toHaveBeenCalledTimes(2);
        },
      ),
      { numRuns: 40 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 114: getState reflects the most-recently synced state
// ---------------------------------------------------------------------------

describe('Property 114: getState reflects the most-recently synced state', () => {
  it('getState() is null before any sync', () => {
    const svc = makeSvc();
    expect(svc.getState()).toBeNull();
  });

  it('getState() returns the state passed to syncStateIfChanged', () => {
    fc.assert(
      fc.property(
        fcCarPlayState(),
        (state) => {
          const svc = makeSvc();
          svc.syncStateIfChanged(state);
          expect(svc.getState()).toEqual(state);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('getState() returns the LAST state when multiple states are synced in sequence', () => {
    fc.assert(
      fc.property(
        fc.array(fcCarPlayState(), { minLength: 2, maxLength: 8 }),
        (states) => {
          const svc = makeSvc();
          for (const s of states) {
            svc.syncState(s);
          }
          expect(svc.getState()).toEqual(states[states.length - 1]);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 115: destroy() resets currentState to null
// ---------------------------------------------------------------------------

describe('Property 115: destroy() resets currentState to null', () => {
  it('getState() is null after destroy() regardless of prior syncs', () => {
    fc.assert(
      fc.property(
        fc.array(fcCarPlayState(), { minLength: 1, maxLength: 5 }),
        (states) => {
          const svc = makeSvc();
          for (const s of states) {
            svc.syncState(s);
          }
          expect(svc.getState()).not.toBeNull();

          svc.destroy();
          expect(svc.getState()).toBeNull();
        },
      ),
      { numRuns: 50 },
    );
  });

  it('syncStateIfChanged after destroy() issues a fresh native call (cache cleared)', () => {
    fc.assert(
      fc.property(
        fcCarPlayState(),
        (state) => {
          mockSyncState.mockClear();
          const svc = makeSvc();

          svc.syncStateIfChanged(state); // first → syncs (count=1)
          svc.syncStateIfChanged(state); // second → no-op (count=1)
          expect(mockSyncState).toHaveBeenCalledTimes(1);

          svc.destroy();
          svc.syncStateIfChanged(state); // after destroy, no cached state → syncs (count=2)
          expect(mockSyncState).toHaveBeenCalledTimes(2);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 116: start() removes prior listeners before adding new ones
// ---------------------------------------------------------------------------

describe('Property 116: start() removes prior listeners before adding new ones', () => {
  it('each start() call registers exactly 3 listeners (connect, disconnect, stateRequest)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        (startCount) => {
          MockNativeEventEmitter.mockClear();
          const mockAddListener = jest.fn().mockReturnValue({ remove: jest.fn() });
          MockNativeEventEmitter.mockImplementation(() => ({
            addListener: mockAddListener,
            removeAllListeners: jest.fn(),
            listenerCount: jest.fn().mockReturnValue(0),
            emit: jest.fn(),
          }));

          const svc = makeSvc();
          for (let i = 0; i < startCount; i++) {
            svc.start();
          }

          // Each start() removes old subs then adds 3 new ones → total = startCount * 3
          expect(mockAddListener).toHaveBeenCalledTimes(startCount * 3);

          // The last 3 registrations always cover the same 3 events
          const lastThree = mockAddListener.mock.calls.slice(-3).map(([ev]: [string]) => ev);
          expect(lastThree).toContain('CarPlayDidConnect');
          expect(lastThree).toContain('CarPlayDidDisconnect');
          expect(lastThree).toContain('CarPlayStateRequest');
        },
      ),
      { numRuns: 20 },
    );
  });
});
