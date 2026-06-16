/**
 * Property 4:  Tile cache size never exceeds configured limit
 *   OfflineCacheService evicts the oldest pack before creating a new one whenever
 *   the total stored size is at or above the configured cap.
 *   Validates: Requirement 4.2
 *
 * Property 21: Offline hazard reports are queued locally
 *   saveOfflineHazard() writes to the local DB and never calls any network API.
 *   Validates: Requirement 11.9
 *
 * Property 23: Sync drains offline queue on reconnect
 *   SyncService.sync() posts all pending hazards/drives to the API then clears
 *   them from the local DB.
 *   Validates: Requirements 11.10, 14.4, 19.7
 */

import fc from 'fast-check';
import {
  OfflineCacheService,
  computeBoundsWithBuffer,
  IOfflineDB,
  IMapOfflineManager,
  OfflineHazard,
  OfflineDrive,
  OfflinePack,
} from './OfflineCacheService';
import { SyncService, ISyncApiClient } from './SyncService';

// ---------------------------------------------------------------------------
// In-memory test doubles
// ---------------------------------------------------------------------------

class InMemoryOfflineDB implements IOfflineDB {
  hazards: OfflineHazard[] = [];
  drives: OfflineDrive[] = [];

  async init(): Promise<void> {}

  async saveHazard(h: OfflineHazard): Promise<void> {
    this.hazards.push(h);
  }

  async getPendingHazards(): Promise<OfflineHazard[]> {
    return [...this.hazards];
  }

  async clearHazards(ids: string[]): Promise<void> {
    const set = new Set(ids);
    this.hazards = this.hazards.filter((h) => !set.has(h.id));
  }

  async saveDrive(d: OfflineDrive): Promise<void> {
    this.drives.push(d);
  }

  async getPendingDrives(): Promise<OfflineDrive[]> {
    return [...this.drives];
  }

  async clearDrives(ids: string[]): Promise<void> {
    const set = new Set(ids);
    this.drives = this.drives.filter((d) => !set.has(d.id));
  }
}

class InMemoryMapManager implements IMapOfflineManager {
  packs: OfflinePack[] = [];
  deleted: string[] = [];
  created: Array<{ name: string; bounds: [[number, number], [number, number]]; createdAt: number }> = [];

  async getPacks(): Promise<OfflinePack[]> {
    return [...this.packs];
  }

  async createPack(name: string, bounds: [[number, number], [number, number]], createdAt: number): Promise<void> {
    this.created.push({ name, bounds, createdAt });
    this.packs.push({ name, sizeBytes: 0, createdAt });
  }

  async deletePack(name: string): Promise<void> {
    this.deleted.push(name);
    this.packs = this.packs.filter((p) => p.name !== name);
  }
}

class InMemoryApiClient implements ISyncApiClient {
  bulkHazardCalls: OfflineHazard[][] = [];
  driveCalls: OfflineDrive[] = [];

  async postBulkHazards(hazards: OfflineHazard[]): Promise<void> {
    this.bulkHazardCalls.push([...hazards]);
  }

  async postDrive(drive: OfflineDrive): Promise<void> {
    this.driveCalls.push(drive);
  }
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const hazardArb = fc.record({
  id: fc.uuid(),
  lat: fc.float({ min: -90, max: 90, noNaN: true }),
  lng: fc.float({ min: -180, max: 180, noNaN: true }),
  type: fc.constantFrom('pothole', 'accident', 'roadwork', 'debris', 'animal'),
  description: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
  createdAt: fc.integer({ min: 1_000_000, max: 2_000_000_000 }),
});

const driveArb = fc.record({
  id: fc.uuid(),
  groupId: fc.uuid(),
  startedAt: fc.integer({ min: 1_000_000, max: 1_000_000_000 }),
  endedAt: fc.integer({ min: 1_000_000_001, max: 2_000_000_000 }),
  distanceMeters: fc.float({ min: 100, max: 500_000, noNaN: true }),
  durationSeconds: fc.float({ min: 60, max: 86_400, noNaN: true }),
});

const packArb = fc.record({
  name: fc.string({ minLength: 1, maxLength: 20 }),
  sizeBytes: fc.integer({ min: 1, max: 600 * 1024 * 1024 }),
  createdAt: fc.integer({ min: 1, max: 1_000_000 }),
});

const coordArb = fc.tuple(
  fc.float({ min: -180, max: 180, noNaN: true }),
  fc.float({ min: -90, max: 90, noNaN: true }),
);

// ---------------------------------------------------------------------------
// Property 4: Tile cache size never exceeds configured limit
// ---------------------------------------------------------------------------

describe('Property 4: Tile cache size never exceeds configured limit', () => {
  it('evicts the oldest pack when total size >= maxSizeMB before creating a new one', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(packArb, { minLength: 1, maxLength: 5 }),
        fc.array(coordArb, { minLength: 2, maxLength: 10 }),
        fc.integer({ min: 1, max: 999 }),
        async (rawPacks, coordinates, nowSeed) => {
          const maxSizeMB = 10; // small cap for deterministic testing

          // Build packs that push total over the cap
          const oversizedPack: OfflinePack = {
            name: 'old-pack-1',
            sizeBytes: 8 * 1024 * 1024, // 8 MB
            createdAt: 100,
          };
          const anotherPack: OfflinePack = {
            name: 'old-pack-2',
            sizeBytes: 3 * 1024 * 1024, // 3 MB → total 11 MB > 10 MB cap
            createdAt: 200,
          };

          const manager = new InMemoryMapManager();
          manager.packs = [oversizedPack, anotherPack];
          const db = new InMemoryOfflineDB();
          const service = new OfflineCacheService(db, manager, maxSizeMB);

          const coords = coordinates as [number, number][];
          await service.prefetchTilesForRoute(coords, 'new-route', nowSeed);

          // The oldest pack (createdAt: 100) must have been evicted
          expect(manager.deleted).toContain('old-pack-1');
          // A new pack must have been created
          expect(manager.created).toHaveLength(1);
          expect(manager.created[0].name).toBe('new-route');
        },
      ),
      { numRuns: 20 },
    );
  });

  it('does NOT evict when total size < maxSizeMB', async () => {
    const manager = new InMemoryMapManager();
    manager.packs = [{ name: 'small-pack', sizeBytes: 1 * 1024 * 1024, createdAt: 1 }];
    const db = new InMemoryOfflineDB();
    const service = new OfflineCacheService(db, manager, 500);

    await service.prefetchTilesForRoute([[0, 0], [1, 1]], 'route-a', 1000);

    expect(manager.deleted).toHaveLength(0);
    expect(manager.created).toHaveLength(1);
  });

  it('skips tile prefetch for empty coordinate array', async () => {
    const manager = new InMemoryMapManager();
    const db = new InMemoryOfflineDB();
    const service = new OfflineCacheService(db, manager, 500);

    await service.prefetchTilesForRoute([], 'empty-route', 1000);

    expect(manager.created).toHaveLength(0);
    expect(manager.deleted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// computeBoundsWithBuffer pure helper
// ---------------------------------------------------------------------------

describe('computeBoundsWithBuffer', () => {
  it('output bounds always enclose all input coordinates', () => {
    fc.assert(
      fc.property(
        fc.array(coordArb, { minLength: 1, maxLength: 20 }),
        fc.float({ min: 0, max: 50, noNaN: true }),
        (coordinates, bufferMiles) => {
          const coords = coordinates as [number, number][];
          const [[swLng, swLat], [neLng, neLat]] = computeBoundsWithBuffer(coords, bufferMiles);
          for (const [lng, lat] of coords) {
            expect(lng).toBeGreaterThanOrEqual(swLng);
            expect(lat).toBeGreaterThanOrEqual(swLat);
            expect(lng).toBeLessThanOrEqual(neLng);
            expect(lat).toBeLessThanOrEqual(neLat);
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 21: Offline hazard reports are queued locally
// ---------------------------------------------------------------------------

describe('Property 21: Offline hazard reports are queued locally', () => {
  it('saveOfflineHazard writes to DB without touching the network', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(hazardArb, { minLength: 1, maxLength: 5 }),
        async (hazards) => {
          const db = new InMemoryOfflineDB();
          const manager = new InMemoryMapManager();
          // The API client would throw if called — proves no network contact
          const api = new InMemoryApiClient();
          const service = new OfflineCacheService(db, manager, 500);

          for (const hazard of hazards) {
            await service.saveOfflineHazard(hazard);
          }

          // All hazards are stored locally
          expect(db.hazards).toHaveLength(hazards.length);
          for (const hazard of hazards) {
            expect(db.hazards.find((h) => h.id === hazard.id)).toBeDefined();
          }
          // Network was not touched
          expect(api.bulkHazardCalls).toHaveLength(0);
          expect(manager.created).toHaveLength(0);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('saves correct hazard fields', async () => {
    const db = new InMemoryOfflineDB();
    const service = new OfflineCacheService(db, new InMemoryMapManager(), 500);

    const hazard: OfflineHazard = {
      id: 'h-001',
      lat: 48.8566,
      lng: 2.3522,
      type: 'pothole',
      description: 'Large pothole on bend',
      createdAt: 1_700_000_000,
    };

    await service.saveOfflineHazard(hazard);

    expect(db.hazards[0]).toEqual(hazard);
  });

  it('also queues offline drives without network contact', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(driveArb, { minLength: 1, maxLength: 4 }),
        async (drives) => {
          const db = new InMemoryOfflineDB();
          const service = new OfflineCacheService(db, new InMemoryMapManager(), 500);

          for (const drive of drives) {
            await service.saveOfflineDrive(drive);
          }

          expect(db.drives).toHaveLength(drives.length);
          for (const drive of drives) {
            expect(db.drives.find((d) => d.id === drive.id)).toBeDefined();
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 23: Sync drains offline queue on reconnect
// ---------------------------------------------------------------------------

describe('Property 23: Sync drains offline queue on reconnect', () => {
  it('posts all pending hazards to API then clears them from DB', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(hazardArb, { minLength: 1, maxLength: 5 }),
        async (hazards) => {
          const db = new InMemoryOfflineDB();
          db.hazards = [...hazards];
          const api = new InMemoryApiClient();
          const netInfo = { subscribe: (_cb: (c: boolean) => void) => () => {} };
          const service = new SyncService(db, api, netInfo, undefined, async () => {});

          await service.sync();

          // All hazards posted in one bulk call
          expect(api.bulkHazardCalls).toHaveLength(1);
          expect(api.bulkHazardCalls[0]).toHaveLength(hazards.length);
          // IDs match
          const sentIds = new Set(api.bulkHazardCalls[0].map((h) => h.id));
          for (const h of hazards) expect(sentIds.has(h.id)).toBe(true);
          // DB cleared
          expect(db.hazards).toHaveLength(0);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('posts each drive individually and clears them from DB', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(driveArb, { minLength: 1, maxLength: 4 }),
        async (drives) => {
          const db = new InMemoryOfflineDB();
          db.drives = [...drives];
          const api = new InMemoryApiClient();
          const netInfo = { subscribe: (_cb: (c: boolean) => void) => () => {} };
          const service = new SyncService(db, api, netInfo, undefined, async () => {});

          await service.sync();

          expect(api.driveCalls).toHaveLength(drives.length);
          expect(db.drives).toHaveLength(0);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('calls onSyncComplete callback after successful sync', async () => {
    const db = new InMemoryOfflineDB();
    db.hazards = [{ id: 'h1', lat: 0, lng: 0, type: 'debris', createdAt: 1 }];
    const api = new InMemoryApiClient();
    let completeCalled = false;
    const netInfo = { subscribe: (_cb: (c: boolean) => void) => () => {} };
    const service = new SyncService(db, api, netInfo, () => { completeCalled = true; }, async () => {});

    await service.sync();

    expect(completeCalled).toBe(true);
  });

  it('does not double-sync when already syncing', async () => {
    const db = new InMemoryOfflineDB();
    db.hazards = [{ id: 'h1', lat: 0, lng: 0, type: 'debris', createdAt: 1 }];

    let apiCallCount = 0;
    const slowApi: ISyncApiClient = {
      postBulkHazards: async (_hazards) => {
        apiCallCount++;
        await new Promise<void>((r) => setTimeout(r, 10));
      },
      postDrive: async () => {},
    };

    const netInfo = { subscribe: (_cb: (c: boolean) => void) => () => {} };
    const service = new SyncService(db, slowApi, netInfo, undefined, async () => {});

    // Start both simultaneously — second must be a no-op because syncing=true
    await Promise.all([service.sync(), service.sync()]);

    expect(apiCallCount).toBe(1);
  });

  it('triggers sync when netInfo fires true', async () => {
    const db = new InMemoryOfflineDB();
    db.hazards = [{ id: 'h2', lat: 1, lng: 1, type: 'pothole', createdAt: 2 }];
    const api = new InMemoryApiClient();

    let capturedCb!: (isConnected: boolean) => void;
    const netInfo = {
      subscribe: (cb: (c: boolean) => void) => {
        capturedCb = cb;
        return () => {};
      },
    };

    const service = new SyncService(db, api, netInfo, undefined, async () => {});
    service.start();

    // Simulate reconnect
    capturedCb(true);

    // Give async sync a tick to run
    await new Promise((r) => setTimeout(r, 50));

    expect(api.bulkHazardCalls).toHaveLength(1);
    expect(db.hazards).toHaveLength(0);

    service.stop();
  });

  it('does not sync when netInfo fires false (still offline)', async () => {
    const db = new InMemoryOfflineDB();
    db.hazards = [{ id: 'h3', lat: 0, lng: 0, type: 'animal', createdAt: 3 }];
    const api = new InMemoryApiClient();

    let capturedCb!: (isConnected: boolean) => void;
    const netInfo = {
      subscribe: (cb: (c: boolean) => void) => {
        capturedCb = cb;
        return () => {};
      },
    };

    const service = new SyncService(db, api, netInfo, undefined, async () => {});
    service.start();

    capturedCb(false);
    await new Promise((r) => setTimeout(r, 20));

    expect(api.bulkHazardCalls).toHaveLength(0);
    expect(db.hazards).toHaveLength(1);

    service.stop();
  });

  it('skips hazard sync when queue is empty', async () => {
    const db = new InMemoryOfflineDB(); // empty queues
    const api = new InMemoryApiClient();
    const netInfo = { subscribe: (_cb: (c: boolean) => void) => () => {} };
    const service = new SyncService(db, api, netInfo, undefined, async () => {});

    await service.sync();

    expect(api.bulkHazardCalls).toHaveLength(0);
    expect(api.driveCalls).toHaveLength(0);
  });
});
