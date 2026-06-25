/**
 * Property tests for SyncService.
 *
 * Property 78: Concurrent sync calls are deduplicated — second call is a no-op
 *   Validates: Requirements 11.10
 *
 * Property 79: Hazard sync retries up to MAX_RETRIES before failing
 *   Validates: Requirements 11.10, 43.1
 *
 * Property 80: Drive sync processes all drives even when some fail
 *   Validates: Requirements 14.4, 19.7
 */

import fc from 'fast-check';
import { SyncService, ISyncApiClient, INetInfoProvider } from './SyncService';
import { IOfflineDB, OfflineHazard, OfflineDrive } from './OfflineCacheService';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeOfflineHazard(id: string): OfflineHazard {
  return {
    id,
    type: 'pothole',
    lat: 37.77,
    lng: -122.41,
    createdAt: Date.now(),
  };
}

function makeOfflineDrive(id: string): OfflineDrive {
  const now = Date.now();
  return {
    id,
    groupId: 'group-1',
    startedAt: now - 300_000,
    endedAt: now,
    distanceMeters: 1000,
    durationSeconds: 300,
    routeTrace: JSON.stringify({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }),
    avgSpeedKph: null,
    topSpeedKph: null,
    memberCount: 1,
  };
}

function makeDb(options: {
  hazards?: OfflineHazard[];
  drives?: OfflineDrive[];
} = {}): { db: IOfflineDB; clearedHazards: string[]; clearedDrives: string[] } {
  const clearedHazards: string[] = [];
  const clearedDrives: string[] = [];

  const db: IOfflineDB = {
    init: jest.fn(async () => {}),
    saveHazard: jest.fn(async () => {}),
    getPendingHazards: jest.fn(async () => options.hazards ?? []),
    clearHazards: jest.fn(async (ids: string[]) => { clearedHazards.push(...ids); }),
    saveDrive: jest.fn(async () => {}),
    getPendingDrives: jest.fn(async () => options.drives ?? []),
    clearDrives: jest.fn(async (ids: string[]) => { clearedDrives.push(...ids); }),
    saveLastPosition: jest.fn(async () => {}),
    getLastPositions: jest.fn(async () => []),
  };

  return { db, clearedHazards, clearedDrives };
}

function makeApi(options: {
  hazardShouldFail?: boolean;
  failDriveIds?: string[];
} = {}): { api: ISyncApiClient; hazardCalls: number; driveCalls: string[] } {
  let hazardCalls = 0;
  const driveCalls: string[] = [];

  const api: ISyncApiClient = {
    postBulkHazards: jest.fn(async () => {
      hazardCalls++;
      if (options.hazardShouldFail) throw new Error('API error');
    }),
    postDrive: jest.fn(async (drive: OfflineDrive) => {
      driveCalls.push(drive.id);
      if (options.failDriveIds?.includes(drive.id)) throw new Error(`Failed: ${drive.id}`);
    }),
  };

  return { api, hazardCalls, driveCalls };
}

function makeNetInfo(): INetInfoProvider {
  return {
    subscribe: jest.fn(() => () => {}),
  };
}

function makeSyncService(
  db: IOfflineDB,
  api: ISyncApiClient,
): { svc: SyncService; completeCalls: number } {
  let completeCalls = 0;
  const svc = new SyncService(
    db,
    api,
    makeNetInfo(),
    () => { completeCalls++; },
    async () => {}, // instant sleep for tests
  );
  return { svc, completeCalls };
}

// ---------------------------------------------------------------------------
// Property 78: Concurrent sync calls are deduplicated
// ---------------------------------------------------------------------------
describe('Property 78: Concurrent sync calls are deduplicated', () => {
  it('second sync() call while first is running is a no-op', async () => {
    let resolveFirst!: () => void;
    const blockFirst = new Promise<void>((r) => { resolveFirst = r; });
    let hazardCallCount = 0;

    const db: IOfflineDB = {
      init: jest.fn(async () => {}),
      saveHazard: jest.fn(async () => {}),
      getPendingHazards: jest.fn(async () => [makeOfflineHazard('h1')]),
      clearHazards: jest.fn(async () => {}),
      saveDrive: jest.fn(async () => {}),
      getPendingDrives: jest.fn(async () => []),
      clearDrives: jest.fn(async () => {}),
      saveLastPosition: jest.fn(async () => {}),
      getLastPositions: jest.fn(async () => []),
    };

    const api: ISyncApiClient = {
      postBulkHazards: jest.fn(async () => {
        hazardCallCount++;
        await blockFirst;
      }),
      postDrive: jest.fn(async () => {}),
    };

    const { svc } = makeSyncService(db, api);

    // Start first sync — it blocks on postBulkHazards
    const first = svc.sync();
    // Second sync should return immediately (guard)
    const second = svc.sync();

    resolveFirst();
    await Promise.all([first, second]);

    // postBulkHazards was called exactly once (second sync was blocked by guard)
    expect(hazardCallCount).toBe(1);
  });

  it('sync() can run again after the first one completes', async () => {
    let callCount = 0;
    const db: IOfflineDB = {
      init: jest.fn(async () => {}),
      saveHazard: jest.fn(async () => {}),
      getPendingHazards: jest.fn(async () => [makeOfflineHazard('h1')]),
      clearHazards: jest.fn(async () => {}),
      saveDrive: jest.fn(async () => {}),
      getPendingDrives: jest.fn(async () => []),
      clearDrives: jest.fn(async () => {}),
      saveLastPosition: jest.fn(async () => {}),
      getLastPositions: jest.fn(async () => []),
    };
    const api: ISyncApiClient = {
      postBulkHazards: jest.fn(async () => { callCount++; }),
      postDrive: jest.fn(async () => {}),
    };

    const { svc } = makeSyncService(db, api);
    await svc.sync();
    await svc.sync();

    expect(callCount).toBe(2);
  });

  it('onSyncComplete is called after each successful sync', async () => {
    const { db } = makeDb({ hazards: [makeOfflineHazard('h1')] });
    const { api } = makeApi();
    let completeCalls = 0;

    const svc = new SyncService(db, api, makeNetInfo(), () => { completeCalls++; }, async () => {});
    await svc.sync();
    await svc.sync();

    expect(completeCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Property 79: Hazard sync retries up to MAX_RETRIES before failing
// ---------------------------------------------------------------------------
describe('Property 79: Hazard sync retries up to MAX_RETRIES before giving up', () => {
  it('retryWithBackoff retries exactly MAX_RETRIES (3) times then throws', async () => {
    let callCount = 0;
    const db: IOfflineDB = {
      init: jest.fn(async () => {}),
      saveHazard: jest.fn(async () => {}),
      getPendingHazards: jest.fn(async () => [makeOfflineHazard('h1')]),
      clearHazards: jest.fn(async () => {}),
      saveDrive: jest.fn(async () => {}),
      getPendingDrives: jest.fn(async () => []),
      clearDrives: jest.fn(async () => {}),
      saveLastPosition: jest.fn(async () => {}),
      getLastPositions: jest.fn(async () => []),
    };
    const api: ISyncApiClient = {
      postBulkHazards: jest.fn(async () => {
        callCount++;
        throw new Error('persistent failure');
      }),
      postDrive: jest.fn(async () => {}),
    };

    const svc = new SyncService(db, api, makeNetInfo(), undefined, async () => {});
    await expect(svc.sync()).rejects.toThrow('persistent failure');
    expect(callCount).toBe(3);
  });

  it('hazard sync does NOT clear pending queue when API fails', async () => {
    const { db, clearedHazards } = makeDb({ hazards: [makeOfflineHazard('h1')] });
    const { api } = makeApi({ hazardShouldFail: true });

    const svc = new SyncService(db, api, makeNetInfo(), undefined, async () => {});
    await expect(svc.sync()).rejects.toThrow();

    // clearHazards never called — queue preserved for next attempt
    expect(clearedHazards).toHaveLength(0);
  });

  it('hazard sync succeeds first try — clears queue and calls onSyncComplete', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        async (count) => {
          const hazards = Array.from({ length: count }, (_, i) => makeOfflineHazard(`h${i}`));
          const { db, clearedHazards } = makeDb({ hazards });
          const { api } = makeApi();
          let completed = 0;

          const svc = new SyncService(db, api, makeNetInfo(), () => { completed++; }, async () => {});
          await svc.sync();

          expect(clearedHazards).toHaveLength(count);
          expect(completed).toBe(1);
        },
      ),
      { numRuns: 10 },
    );
  });

  it('no hazards pending — postBulkHazards is never called', async () => {
    const { db } = makeDb({ hazards: [] });
    const { api } = makeApi();

    const { svc } = makeSyncService(db, api);
    await svc.sync();

    expect(api.postBulkHazards).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Property 80: Drive sync processes all drives even when some fail
// ---------------------------------------------------------------------------
describe('Property 80: Drive sync processes all drives even when some fail', () => {
  it('all drives are attempted even when earlier drives fail', async () => {
    const drives = ['d1', 'd2', 'd3'].map(makeOfflineDrive);
    const { db, clearedDrives } = makeDb({ drives });
    const { api, driveCalls } = makeApi({ failDriveIds: ['d1'] });

    const svc = new SyncService(db, api, makeNetInfo(), undefined, async () => {});
    await expect(svc.sync()).rejects.toThrow();

    // All 3 drives were attempted
    expect(driveCalls).toEqual(expect.arrayContaining(['d1', 'd2', 'd3']));
    // Successful drives (d2, d3) were cleared from queue
    expect(clearedDrives).toContain('d2');
    expect(clearedDrives).toContain('d3');
    // Failed drive (d1) was NOT cleared
    expect(clearedDrives).not.toContain('d1');
  });

  it('when all drives succeed, all are cleared from queue', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        async (count) => {
          const drives = Array.from({ length: count }, (_, i) => makeOfflineDrive(`d${i}`));
          const { db, clearedDrives } = makeDb({ drives });
          const { api } = makeApi();

          const { svc } = makeSyncService(db, api);
          await svc.sync();

          expect(clearedDrives).toHaveLength(count);
          for (let i = 0; i < count; i++) {
            expect(clearedDrives).toContain(`d${i}`);
          }
        },
      ),
      { numRuns: 10 },
    );
  });

  it('when no drives pending — postDrive is never called', async () => {
    const { db } = makeDb({ drives: [] });
    const { api } = makeApi();

    const { svc } = makeSyncService(db, api);
    await svc.sync();

    expect(api.postDrive).not.toHaveBeenCalled();
  });

  it('sync error from drives is re-thrown after all drives are attempted', async () => {
    const drives = ['d1', 'd2'].map(makeOfflineDrive);
    const { db } = makeDb({ drives });
    const { api } = makeApi({ failDriveIds: ['d1', 'd2'] });

    const svc = new SyncService(db, api, makeNetInfo(), undefined, async () => {});
    await expect(svc.sync()).rejects.toThrow('Failed: d2');
  });
});
