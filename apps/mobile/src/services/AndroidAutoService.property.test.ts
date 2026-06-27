/**
 * Property tests for AndroidAutoService.
 *
 * Property A1: syncStateIfChanged skips native call when state is identical
 * Property A2: syncStateIfChanged calls native when any field changes
 * Property A3: isConnected tracks connect/disconnect events correctly
 * Property A4: destroy clears all subscriptions and cached state
 * Property A5: start() is idempotent — no listener accumulation
 */

import fc from 'fast-check';

// ---------------------------------------------------------------------------
// Mocks — all state defined inside the factory; exposed via __mocks__ key
// so Jest hoisting doesn't break reference access.
// ---------------------------------------------------------------------------

jest.mock('react-native', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers: Record<string, Array<(...args: any[]) => void>> = {};
  const syncStateMock = jest.fn();
  const isSessionActiveMock = jest.fn().mockResolvedValue(false);

  return {
    DeviceEventEmitter: {
      addListener: jest.fn((event: string, handler: () => void) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
        return {
          remove: jest.fn(() => {
            const list = handlers[event];
            if (!list) return;
            const idx = list.indexOf(handler);
            if (idx > -1) list.splice(idx, 1);
          }),
        };
      }),
    },
    NativeModules: {
      ConvoyAndroidAuto: {
        syncState: syncStateMock,
        isSessionActive: isSessionActiveMock,
      },
    },
    Platform: { OS: 'android' },
    EmitterSubscription: class {},
    // Test helpers exposed via the mock module
    __handlers: handlers,
    __syncState: syncStateMock,
  };
});

// Access mock internals AFTER jest.mock registration
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rnMock = require('react-native') as {
  __handlers: Record<string, Array<() => void>>;
  __syncState: jest.Mock;
  DeviceEventEmitter: { addListener: jest.Mock };
};

import { AndroidAutoService, AndroidAutoState, DrivingData } from './AndroidAutoService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emit(event: string): void {
  (rnMock.__handlers[event] ?? []).forEach((h) => h());
}

function listenerCount(event: string): number {
  return (rnMock.__handlers[event] ?? []).length;
}

function clearHandlers(): void {
  Object.keys(rnMock.__handlers).forEach((k) => { rnMock.__handlers[k] = []; });
}

const fcState = fc.record<AndroidAutoState>({
  groupId: fc.oneof(fc.constant(null as string | null), fc.string({ minLength: 1, maxLength: 20 })),
  memberCount: fc.integer({ min: 0, max: 50 }),
  routeActive: fc.boolean(),
  pttChannelId: fc.oneof(fc.constant(null as string | null), fc.string({ minLength: 1, maxLength: 20 })),
  myCallsign: fc.string({ minLength: 1, maxLength: 10 }),
  activeGroupName: fc.oneof(fc.constant(null as string | null), fc.string({ minLength: 1, maxLength: 40 })),
  nearbyGroupCount: fc.integer({ min: 0, max: 50 }),
  convoyStatus: fc.oneof(fc.constant('idle' as const), fc.constant('active' as const), fc.constant('ending' as const)),
  transmittingMemberCallsign: fc.oneof(fc.constant(null as string | null), fc.string({ minLength: 1, maxLength: 20 })),
  nextWaypointName: fc.oneof(fc.constant(null as string | null), fc.string({ minLength: 1, maxLength: 40 })),
  nextWaypointEtaMinutes: fc.oneof(fc.constant(null as number | null), fc.integer({ min: 1, max: 120 })),
  gapToCarAheadM: fc.oneof(fc.constant(null as number | null), fc.integer({ min: 0, max: 5000 })),
  speedKph: fc.integer({ min: 0, max: 300 }),
  speedLimitKph: fc.oneof(fc.constant(null as number | null), fc.integer({ min: 30, max: 130 })),
  isOverSpeedLimit: fc.boolean(),
  positionInConvoy: fc.integer({ min: 1, max: 20 }),
  convoyTotalCars: fc.integer({ min: 1, max: 20 }),
});

beforeEach(() => {
  rnMock.__syncState.mockClear();
  rnMock.DeviceEventEmitter.addListener.mockClear();
  clearHandlers();
});

// ---------------------------------------------------------------------------
// Property A1: syncStateIfChanged skips when state is identical
// ---------------------------------------------------------------------------

describe('Property A1: syncStateIfChanged skips native call for identical state', () => {
  it('second call with same state does not call syncState again', () => {
    fc.assert(
      fc.property(fcState, (state) => {
        clearHandlers();
        rnMock.__syncState.mockClear();
        const svc = new AndroidAutoService();
        svc.start();
        svc.syncStateIfChanged(state);
        svc.syncStateIfChanged(state);
        expect(rnMock.__syncState).toHaveBeenCalledTimes(1);
      }),
      { numRuns: 50 },
    );
  });

  it('N repeated calls with the same state still push only once', () => {
    fc.assert(
      fc.property(
        fcState,
        fc.integer({ min: 2, max: 8 }),
        (state, n) => {
          clearHandlers();
          rnMock.__syncState.mockClear();
          const svc = new AndroidAutoService();
          svc.start();
          for (let i = 0; i < n; i++) svc.syncStateIfChanged(state);
          expect(rnMock.__syncState).toHaveBeenCalledTimes(1);
        },
      ),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property A2: syncStateIfChanged calls native when a field changes
// ---------------------------------------------------------------------------

describe('Property A2: syncStateIfChanged calls native when any field changes', () => {
  it('first call with any state always reaches native', () => {
    fc.assert(
      fc.property(fcState, (state) => {
        clearHandlers();
        rnMock.__syncState.mockClear();
        const svc = new AndroidAutoService();
        svc.start();
        svc.syncStateIfChanged(state);
        expect(rnMock.__syncState).toHaveBeenCalledTimes(1);
        expect(rnMock.__syncState).toHaveBeenCalledWith(state);
      }),
      { numRuns: 50 },
    );
  });

  it('flipping routeActive always triggers a second sync', () => {
    fc.assert(
      fc.property(fcState, (base) => {
        clearHandlers();
        rnMock.__syncState.mockClear();
        const svc = new AndroidAutoService();
        svc.start();
        svc.syncStateIfChanged(base);
        svc.syncStateIfChanged({ ...base, routeActive: !base.routeActive });
        expect(rnMock.__syncState).toHaveBeenCalledTimes(2);
      }),
      { numRuns: 30 },
    );
  });

  it('changing memberCount to a different value triggers a second sync', () => {
    fc.assert(
      fc.property(
        fcState,
        fc.integer({ min: 0, max: 50 }),
        (base, newCount) => {
          fc.pre(newCount !== base.memberCount);
          clearHandlers();
          rnMock.__syncState.mockClear();
          const svc = new AndroidAutoService();
          svc.start();
          svc.syncStateIfChanged(base);
          svc.syncStateIfChanged({ ...base, memberCount: newCount });
          expect(rnMock.__syncState).toHaveBeenCalledTimes(2);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('changing myCallsign triggers a second sync', () => {
    fc.assert(
      fc.property(
        fcState,
        fc.string({ minLength: 1, maxLength: 10 }),
        (base, newCallsign) => {
          fc.pre(newCallsign !== base.myCallsign);
          clearHandlers();
          rnMock.__syncState.mockClear();
          const svc = new AndroidAutoService();
          svc.start();
          svc.syncStateIfChanged(base);
          svc.syncStateIfChanged({ ...base, myCallsign: newCallsign });
          expect(rnMock.__syncState).toHaveBeenCalledTimes(2);
        },
      ),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property A3: isConnected tracks connect/disconnect events
// ---------------------------------------------------------------------------

describe('Property A3: isConnected tracks connect/disconnect events', () => {
  it('starts false before any events', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99 }), (_seed) => {
        clearHandlers();
        const svc = new AndroidAutoService();
        svc.start();
        expect(svc.isConnected()).toBe(false);
      }),
      { numRuns: 20 },
    );
  });

  it('true after connect event, false after disconnect', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99 }), (_seed) => {
        clearHandlers();
        const svc = new AndroidAutoService();
        svc.start();
        emit('AndroidAutoDidConnect');
        expect(svc.isConnected()).toBe(true);
        emit('AndroidAutoDidDisconnect');
        expect(svc.isConnected()).toBe(false);
      }),
      { numRuns: 20 },
    );
  });

  it('connect/disconnect alternation always reflects the latest event', () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }),
        (events) => {
          clearHandlers();
          const svc = new AndroidAutoService();
          svc.start();
          let lastExpected = false;
          for (const isConnect of events) {
            if (isConnect) {
              emit('AndroidAutoDidConnect');
              lastExpected = true;
            } else {
              emit('AndroidAutoDidDisconnect');
              lastExpected = false;
            }
          }
          expect(svc.isConnected()).toBe(lastExpected);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('disconnect clears lastState so next syncStateIfChanged always pushes', () => {
    fc.assert(
      fc.property(fcState, (state) => {
        clearHandlers();
        rnMock.__syncState.mockClear();
        const svc = new AndroidAutoService();
        svc.start();
        svc.syncStateIfChanged(state);    // primes cache
        rnMock.__syncState.mockClear();
        emit('AndroidAutoDidDisconnect'); // clears cache
        svc.syncStateIfChanged(state);    // same state, but cache gone → must push
        expect(rnMock.__syncState).toHaveBeenCalledTimes(1);
      }),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property A4: destroy clears all state
// ---------------------------------------------------------------------------

describe('Property A4: destroy clears subscriptions and cached state', () => {
  it('isConnected is false after destroy even if previously connected', () => {
    clearHandlers();
    const svc = new AndroidAutoService();
    svc.start();
    emit('AndroidAutoDidConnect');
    expect(svc.isConnected()).toBe(true);
    svc.destroy();
    expect(svc.isConnected()).toBe(false);
  });

  it('session change listeners are not fired after destroy', () => {
    clearHandlers();
    const svc = new AndroidAutoService();
    svc.start();
    let fired = 0;
    svc.onCarPlaySessionChange(() => { fired++; });
    svc.destroy();
    emit('AndroidAutoDidConnect');
    expect(fired).toBe(0);
  });

  it('destroy is safe to call multiple times without throwing', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), (n) => {
        clearHandlers();
        const svc = new AndroidAutoService();
        svc.start();
        expect(() => {
          for (let i = 0; i < n; i++) svc.destroy();
        }).not.toThrow();
      }),
      { numRuns: 10 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property A5: start() is idempotent — no listener accumulation
// ---------------------------------------------------------------------------

describe('Property A5: start() called multiple times does not accumulate listeners', () => {
  it('N calls to start() result in exactly one handler per event', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), (n) => {
        clearHandlers();
        const svc = new AndroidAutoService();
        for (let i = 0; i < n; i++) svc.start();
        expect(listenerCount('AndroidAutoDidConnect')).toBe(1);
        expect(listenerCount('AndroidAutoDidDisconnect')).toBe(1);
      }),
      { numRuns: 20 },
    );
  });

  it('session change listener fires exactly once per connect regardless of start() count', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), (startCount) => {
        clearHandlers();
        const svc = new AndroidAutoService();
        for (let i = 0; i < startCount; i++) svc.start();
        let fired = 0;
        svc.onCarPlaySessionChange(() => { fired++; });
        emit('AndroidAutoDidConnect');
        expect(fired).toBe(1);
      }),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property PA_CLUSTER_1: lead car always has null gapToCarAheadM
// ---------------------------------------------------------------------------

describe('PA_CLUSTER_1: updateDrivingData sets gapToCarAheadM=null when positionInConvoy===1', () => {
  it('lead car gap is always null regardless of input gapToCarAheadM', () => {
    fc.assert(
      fc.property(
        fcState,
        fc.integer({ min: 0, max: 5000 }),
        (base, gap) => {
          clearHandlers();
          rnMock.__syncState.mockClear();
          const svc = new AndroidAutoService();
          svc.start();
          svc.syncStateIfChanged(base);
          const data: DrivingData = { speedKph: 60, positionInConvoy: 1, gapToCarAheadM: gap };
          svc.updateDrivingData(data);
          const synced: AndroidAutoState = rnMock.__syncState.mock.calls[rnMock.__syncState.mock.calls.length - 1]?.[0];
          if (synced) {
            expect(synced.gapToCarAheadM).toBeNull();
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('non-lead car preserves gapToCarAheadM from input', () => {
    fc.assert(
      fc.property(
        fcState,
        fc.integer({ min: 2, max: 20 }),
        fc.integer({ min: 0, max: 5000 }),
        (base, position, gap) => {
          clearHandlers();
          rnMock.__syncState.mockClear();
          const svc = new AndroidAutoService();
          svc.start();
          svc.syncStateIfChanged({ ...base, gapToCarAheadM: null });
          const data: DrivingData = { speedKph: 60, positionInConvoy: position, gapToCarAheadM: gap };
          svc.updateDrivingData(data);
          const calls = rnMock.__syncState.mock.calls;
          const synced: AndroidAutoState | undefined = calls[calls.length - 1]?.[0];
          if (synced && synced.positionInConvoy !== 1) {
            expect(synced.gapToCarAheadM).toBe(gap);
          }
        },
      ),
      { numRuns: 80 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property PA_CLUSTER_2: isOverSpeedLimit is false when speedLimitKph is null
// ---------------------------------------------------------------------------

describe('PA_CLUSTER_2: isOverSpeedLimit is always false when speedLimitKph is null', () => {
  it('any speed with null limit never triggers over-speed', () => {
    fc.assert(
      fc.property(
        fcState,
        fc.integer({ min: 0, max: 300 }),
        (base, speedKph) => {
          clearHandlers();
          rnMock.__syncState.mockClear();
          const svc = new AndroidAutoService();
          svc.start();
          svc.syncStateIfChanged({ ...base, speedLimitKph: null });
          svc.updateDrivingData({ speedKph, speedLimitKph: undefined });
          const calls = rnMock.__syncState.mock.calls;
          const synced: AndroidAutoState | undefined = calls[calls.length - 1]?.[0];
          if (synced && synced.speedLimitKph === null) {
            expect(synced.isOverSpeedLimit).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('speed exactly at limit + 5 is not over-speed, limit + 6 is', () => {
    fc.assert(
      fc.property(
        fcState,
        fc.integer({ min: 30, max: 130 }),
        (base, limit) => {
          clearHandlers();
          rnMock.__syncState.mockClear();
          const svc = new AndroidAutoService();
          svc.start();
          svc.syncStateIfChanged({ ...base, speedLimitKph: limit });

          // exactly at threshold — not over
          svc.updateDrivingData({ speedKph: limit + 5, speedLimitKph: limit });
          let calls = rnMock.__syncState.mock.calls;
          let synced: AndroidAutoState | undefined = calls[calls.length - 1]?.[0];
          if (synced) expect(synced.isOverSpeedLimit).toBe(false);

          // one above threshold — over
          svc.updateDrivingData({ speedKph: limit + 6, speedLimitKph: limit });
          calls = rnMock.__syncState.mock.calls;
          synced = calls[calls.length - 1]?.[0];
          if (synced) expect(synced.isOverSpeedLimit).toBe(true);
        },
      ),
      { numRuns: 80 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property PA_CLUSTER_3: getClusterDisplayText() never throws
// ---------------------------------------------------------------------------

describe('PA_CLUSTER_3: getClusterDisplayText() never throws for any valid state', () => {
  it('returns a non-empty string for any combination of state', () => {
    fc.assert(
      fc.property(fcState, (state) => {
        clearHandlers();
        const svc = new AndroidAutoService();
        svc.start();
        svc.syncStateIfChanged(state);
        let result: string;
        expect(() => { result = svc.getClusterDisplayText(); }).not.toThrow();
        expect(typeof result!).toBe('string');
        expect(result!.length).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });

  it('idle/ending status always returns "CONVOY · Ready"', () => {
    fc.assert(
      fc.property(
        fcState,
        fc.oneof(fc.constant('idle' as const), fc.constant('ending' as const)),
        (base, status) => {
          clearHandlers();
          const svc = new AndroidAutoService();
          svc.start();
          svc.syncStateIfChanged({ ...base, convoyStatus: status });
          expect(svc.getClusterDisplayText()).toBe('CONVOY · Ready');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('active + position 1 always returns lead car text', () => {
    fc.assert(
      fc.property(fcState, fc.integer({ min: 2, max: 20 }), (base, total) => {
        clearHandlers();
        const svc = new AndroidAutoService();
        svc.start();
        svc.syncStateIfChanged({ ...base, convoyStatus: 'active', positionInConvoy: 1, convoyTotalCars: total });
        const text = svc.getClusterDisplayText();
        expect(text).toContain('Lead Car');
        expect(text).toContain(`${total - 1} following`);
      }),
      { numRuns: 100 },
    );
  });
});
