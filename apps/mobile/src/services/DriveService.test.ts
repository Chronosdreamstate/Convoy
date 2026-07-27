/**
 * DriveService end-of-drive navigation contract (Req 7.9, 19.4).
 *
 * The pure stats helpers are property-tested in DriveService.property.test.ts.
 * This file covers the exactly-once /convoy-end navigation the shared instance
 * adds on top: when a convoy ends, MapScreen's `group:ended` socket handler
 * and ConvoyScreen's Admin end flow both race to open the summary screen (the
 * server broadcasts to the whole room — Admin included — while the Admin's
 * POST /end is still in flight). claimEndNavigation() lets exactly one path
 * navigate, and buildConvoyEndParams() makes both paths equally rich so it
 * does not matter which one wins.
 */

import {
  DriveService,
  DriveStats,
  buildConvoyEndParams,
  driveService,
} from './DriveService';

const richStats: DriveStats = {
  routeTrace: { type: 'LineString', coordinates: [[-122.4, 37.7], [-122.3, 37.8], [-122.2, 37.9]] },
  distanceM: 24_500,
  durationS: 1_800,
  avgSpeedKph: 49,
  topSpeedKph: 98.6,
};

describe('DriveService.claimEndNavigation (exactly-once end-screen push)', () => {
  it('grants the claim to the first caller only', () => {
    const svc = new DriveService();
    svc.startSession(1_000);

    expect(svc.claimEndNavigation('g1')).toBe(true);   // e.g. MapScreen socket handler
    expect(svc.claimEndNavigation('g1')).toBe(false);  // e.g. ConvoyScreen POST /end response
    expect(svc.claimEndNavigation('g1')).toBe(false);  // duplicate socket event
  });

  it('is claimable even before any session has started (cold end event)', () => {
    const svc = new DriveService();
    expect(svc.claimEndNavigation('g1')).toBe(true);
    expect(svc.claimEndNavigation('g1')).toBe(false);
  });

  it('re-arms when the next session starts', () => {
    const svc = new DriveService();
    svc.startSession(1_000);
    expect(svc.claimEndNavigation('g1')).toBe(true);

    svc.startSession(2_000);
    expect(svc.claimEndNavigation('g1')).toBe(true);
    expect(svc.claimEndNavigation('g1')).toBe(false);
  });

  it("re-arms for a different group even if startSession never ran — an Admin who runs convoys entirely from the convoy tab (MapScreen never mounts) must still get convoy #2's end screen", () => {
    const svc = new DriveService();
    expect(svc.claimEndNavigation('g1')).toBe(true);   // convoy #1 ends
    expect(svc.claimEndNavigation('g2')).toBe(true);   // convoy #2 ends, no startSession between
    expect(svc.claimEndNavigation('g2')).toBe(false);  // still exactly-once per group
  });

  it('stays claimed across finishSession() — the drive save must not re-open navigation', async () => {
    const svc = new DriveService();
    svc.startSession(0);
    svc.addPoint(37.7, -122.4, 50, 0);
    svc.addPoint(37.8, -122.3, 60, 60_000);

    expect(svc.claimEndNavigation('g1')).toBe(true);

    await svc.finishSession({
      groupId: 'g1',
      memberCount: 3,
      offlineCache: { saveDrive: jest.fn().mockResolvedValue(undefined), clearDrives: jest.fn().mockResolvedValue(undefined) },
      api: { postDrive: jest.fn().mockRejectedValue(new Error('offline')) },
      isOnline: () => false,
      nowMs: 60_000,
    });

    // MapScreen's unmount cleanup calls finishSession again (idempotent) — the
    // claim must survive that too.
    expect(svc.claimEndNavigation('g1')).toBe(false);
  });

  it('exports one app-wide instance shared by both screens', () => {
    expect(driveService).toBeInstanceOf(DriveService);
  });
});

describe('DriveService.finishSession (no duplicate drive after online upload)', () => {
  it('clears the SQLite copy after a successful POST so SyncService cannot re-post it', async () => {
    const svc = new DriveService();
    svc.startSession(0);
    svc.addPoint(37.7, -122.4, 50, 0);
    svc.addPoint(37.8, -122.3, 60, 60_000);

    const saveDrive = jest.fn().mockResolvedValue(undefined);
    const clearDrives = jest.fn().mockResolvedValue(undefined);
    const postDrive = jest.fn().mockResolvedValue({ id: 'server-1' });

    const record = await svc.finishSession({
      groupId: 'g1',
      memberCount: 3,
      offlineCache: { saveDrive, clearDrives },
      api: { postDrive },
      isOnline: () => true,
      nowMs: 60_000,
    });

    expect(record).toEqual({ id: 'server-1' });
    expect(postDrive).toHaveBeenCalledTimes(1);
    // The exact id it saved must be the exact id it clears.
    const savedId = saveDrive.mock.calls[0][0].id;
    expect(clearDrives).toHaveBeenCalledWith([savedId]);
  });

  it('keeps the SQLite copy when the POST fails so SyncService can retry it', async () => {
    const svc = new DriveService();
    svc.startSession(0);
    svc.addPoint(37.7, -122.4, 50, 0);
    svc.addPoint(37.8, -122.3, 60, 60_000);

    const clearDrives = jest.fn().mockResolvedValue(undefined);

    const record = await svc.finishSession({
      groupId: 'g1',
      memberCount: 3,
      offlineCache: { saveDrive: jest.fn().mockResolvedValue(undefined), clearDrives },
      api: { postDrive: jest.fn().mockRejectedValue(new Error('network')) },
      isOnline: () => true,
      nowMs: 60_000,
    });

    expect(record).toBeNull();
    expect(clearDrives).not.toHaveBeenCalled();
  });
});

describe('buildConvoyEndParams (richest params for whichever path wins)', () => {
  it('combines server group stats with locally-recorded top speed and trace', () => {
    const params = buildConvoyEndParams({
      groupName: 'Canyon Run',
      memberCount: 4,
      durationS: 3_600,
      distanceM: 80_000,
      localStats: richStats,
    });

    expect(params).toEqual({
      groupName: 'Canyon Run',
      memberCount: '4',
      durationMinutes: '60',
      distanceM: '80000',
      topSpeedKmh: '99', // rounded from 98.6
      routeTrace: JSON.stringify(richStats.routeTrace),
    });
  });

  it('falls back to local stats when the server payload carries none (e.g. auto-end emits)', () => {
    const params = buildConvoyEndParams({
      groupName: 'Canyon Run',
      memberCount: 2,
      durationS: undefined,
      distanceM: 0,
      localStats: richStats,
    });

    expect(params.durationMinutes).toBe('30');  // 1800 s from local recording
    expect(params.distanceM).toBe('24500');
  });

  it('omits top speed and trace when there is no local recording', () => {
    const params = buildConvoyEndParams({
      groupName: 'Canyon Run',
      memberCount: 4,
      durationS: 3_600,
      distanceM: 80_000,
      localStats: null,
    });

    expect(params).not.toHaveProperty('topSpeedKmh');
    expect(params).not.toHaveProperty('routeTrace');
    expect(params.durationMinutes).toBe('60');
  });

  it('omits a degenerate single-point trace and a null top speed', () => {
    const params = buildConvoyEndParams({
      groupName: 'Canyon Run',
      memberCount: 1,
      durationS: 60,
      distanceM: 10,
      localStats: {
        ...richStats,
        topSpeedKph: null, // all GPS speed readings were 0
        routeTrace: { type: 'LineString', coordinates: [[-122.4, 37.7]] },
      },
    });

    expect(params).not.toHaveProperty('topSpeedKmh');
    expect(params).not.toHaveProperty('routeTrace');
  });

  it('defaults the group name when missing', () => {
    expect(buildConvoyEndParams({
      groupName: null,
      memberCount: 1,
      durationS: 0,
      distanceM: 0,
      localStats: null,
    }).groupName).toBe('Convoy');
  });

  it('yields identical params for both racing paths given the same inputs', () => {
    const input = {
      groupName: 'Canyon Run',
      memberCount: 4,
      durationS: 3_600,
      distanceM: 80_000,
      localStats: richStats,
    };
    // MapScreen (socket) and ConvoyScreen (POST response) build from the same
    // shared session — the end screen must not care who won the claim.
    expect(buildConvoyEndParams(input)).toEqual(buildConvoyEndParams(input));
  });
});
