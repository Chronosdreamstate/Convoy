/**
 * Property tests for rally point and SOS systems.
 * Property 33: Rally point cancellation is globally consistent (Req 20.5)
 * Property 34: Rally broadcast disabled without active group (Req 20.6)
 * Property 41: SOS cancellation removes pin from all Members' maps (Req 25.6)
 */

import fc from 'fast-check';
import {
  canBroadcastRally,
  canCancelRally,
  canCancelSos,
  deactivatePreviousRallies,
  getActiveGroupSos,
  serializeRallyRow,
  RawRallyRow,
} from './rally.routes';

// ---------------------------------------------------------------------------
// Property 33: Rally point cancellation is globally consistent
// ---------------------------------------------------------------------------

describe('Property 33: Rally point cancellation is globally consistent', () => {
  test('P33.1: active rally is always cancellable', () => {
    expect(canCancelRally(true)).toBe(true);
  });

  test('P33.2: already-cancelled rally cannot be cancelled again', () => {
    expect(canCancelRally(false)).toBe(false);
  });

  test('P33.3: canCancelRally returns the is_active flag unchanged', () => {
    fc.assert(
      fc.property(fc.boolean(), (isActive) => {
        expect(canCancelRally(isActive)).toBe(isActive);
      }),
    );
  });

  test('P33.4: serializeRallyRow round-trip preserves every field', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.uuid(),
        // lat/lng: use small integers to avoid 32-bit float precision issues
        fc.integer({ min: -90, max: 90 }).map((n) => n as number),
        fc.integer({ min: -180, max: 180 }).map((n) => n as number),
        fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: null }),
        fc.boolean(),
        fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') }),
        (id, broadcasterId, lat, lng, address, isActive, createdAt) => {
          const row: RawRallyRow = {
            id,
            broadcaster_id: broadcasterId,
            lat,
            lng,
            address,
            is_active: isActive,
            created_at: createdAt,
          };
          const res = serializeRallyRow(row);
          expect(res.id).toBe(row.id);
          expect(res.broadcasterId).toBe(row.broadcaster_id);
          expect(res.lat).toBe(row.lat);
          expect(res.lng).toBe(row.lng);
          expect(res.address).toBe(row.address);
          expect(res.isActive).toBe(row.is_active);
          expect(res.createdAt).toBe(row.created_at.toISOString());
        },
      ),
    );
  });

  test('P33.5: cancelled rally (isActive=false) serialises isActive as false', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (id, broadcasterId) => {
        const row: RawRallyRow = {
          id,
          broadcaster_id: broadcasterId,
          lat: 0,
          lng: 0,
          address: null,
          is_active: false,
          created_at: new Date('2024-06-01T00:00:00Z'),
        };
        expect(serializeRallyRow(row).isActive).toBe(false);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 34: Rally broadcast disabled without active group
// ---------------------------------------------------------------------------

describe('Property 34: Rally broadcast disabled without active group', () => {
  test('P34.1: canBroadcastRally returns false when user has no active group', () => {
    expect(canBroadcastRally(false)).toBe(false);
  });

  test('P34.2: canBroadcastRally returns true when user has an active group', () => {
    expect(canBroadcastRally(true)).toBe(true);
  });

  test('P34.3: canBroadcastRally is identical to the hasActiveGroup argument', () => {
    fc.assert(
      fc.property(fc.boolean(), (hasActiveGroup) => {
        expect(canBroadcastRally(hasActiveGroup)).toBe(hasActiveGroup);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 41: SOS cancellation removes pin from all Members' maps
// ---------------------------------------------------------------------------

describe('Property 41: SOS cancellation removes pin from all Members maps', () => {
  test('P41.1: SOS owner can always cancel their own pin', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.option(fc.uuid(), { nil: null }),
        (ownerId, groupAdminId) => {
          expect(
            canCancelSos({ requesterId: ownerId, sosOwnerId: ownerId, groupAdminId }),
          ).toBe(true);
        },
      ),
    );
  });

  test('P41.2: group admin can cancel any members SOS', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (adminId, ownerId) => {
        fc.pre(adminId !== ownerId);
        expect(
          canCancelSos({ requesterId: adminId, sosOwnerId: ownerId, groupAdminId: adminId }),
        ).toBe(true);
      }),
    );
  });

  test('P41.3: non-owner, non-admin cannot cancel SOS', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), fc.uuid(), (requesterId, ownerId, adminId) => {
        fc.pre(requesterId !== ownerId && requesterId !== adminId);
        expect(
          canCancelSos({ requesterId, sosOwnerId: ownerId, groupAdminId: adminId }),
        ).toBe(false);
      }),
    );
  });

  test('P41.4: with no group admin, only the owner can cancel', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (requesterId, ownerId) => {
        fc.pre(requesterId !== ownerId);
        expect(
          canCancelSos({ requesterId, sosOwnerId: ownerId, groupAdminId: null }),
        ).toBe(false);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Single active rally per group (Req 20.3) — broadcasting a new rally must
// retire every previous active row and emit rally:cancelled for each so no
// stale pin survives on Members' maps.
// ---------------------------------------------------------------------------
describe('deactivatePreviousRallies (Req 20.3)', () => {
  function buildIo(log: Array<{ room: string; event: string; data: unknown }>) {
    return {
      to: (room: string) => ({
        emit: (event: string, data: unknown) => { log.push({ room, event, data }); },
      }),
    };
  }

  test('deactivates every active rally and emits rally:cancelled for each', async () => {
    const log: Array<{ room: string; event: string; data: unknown }> = [];
    const db = {
      query: async () => ({ rows: [{ id: 'r-1' }, { id: 'r-2' }], rowCount: 2 }),
    } as unknown as import('pg').Pool;

    const ids = await deactivatePreviousRallies(db, buildIo(log), 'g-1');

    expect(ids).toEqual(['r-1', 'r-2']);
    expect(log).toEqual([
      { room: 'group:g-1', event: 'rally:cancelled', data: { rallyId: 'r-1', groupId: 'g-1' } },
      { room: 'group:g-1', event: 'rally:cancelled', data: { rallyId: 'r-2', groupId: 'g-1' } },
    ]);
  });

  test('no active rallies: no emissions, empty result', async () => {
    const log: Array<{ room: string; event: string; data: unknown }> = [];
    const db = {
      query: async () => ({ rows: [], rowCount: 0 }),
    } as unknown as import('pg').Pool;

    const ids = await deactivatePreviousRallies(db, buildIo(log), 'g-1');

    expect(ids).toEqual([]);
    expect(log).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Active SOS backfill (Req 25.4, 25.5) — late joiners / reconnects fetch the
// group's live SOS pins from Redis; expired or malformed entries are skipped
// and each pin carries the sender's name.
// ---------------------------------------------------------------------------
describe('getActiveGroupSos (Req 25.4, 25.5)', () => {
  function buildDb(memberIds: string[], names: Array<{ id: string; display_name: string; ptt_callsign: string | null }>) {
    return {
      query: async (sql: string) => {
        if (sql.includes('convoy_members')) {
          return { rows: memberIds.map((user_id) => ({ user_id })), rowCount: memberIds.length };
        }
        return { rows: names, rowCount: names.length };
      },
    } as unknown as import('pg').Pool;
  }

  function buildRedis(entries: Record<string, string | null>) {
    return {
      mget: async (...keys: string[]) => keys.map((k) => entries[k] ?? null),
    } as unknown as import('ioredis').default;
  }

  test('returns each members active pin with senderName resolved (callsign wins over display name)', async () => {
    const db = buildDb(
      ['u-1', 'u-2'],
      [
        { id: 'u-1', display_name: 'Alice', ptt_callsign: 'Red Leader' },
        { id: 'u-2', display_name: 'Bob', ptt_callsign: null },
      ],
    );
    const redis = buildRedis({
      'sos:user:g-1:u-1': 's-1',
      'sos:user:g-1:u-2': 's-2',
      'sos:s-1': JSON.stringify({ userId: 'u-1', lat: 1, lng: 2, type: 'breakdown', createdAt: '2026-07-14T00:00:00Z' }),
      'sos:s-2': JSON.stringify({ userId: 'u-2', lat: 3, lng: 4, createdAt: '2026-07-14T00:01:00Z' }),
    });

    const pins = await getActiveGroupSos(db, redis, 'g-1');

    expect(pins).toHaveLength(2);
    expect(pins[0]).toMatchObject({ id: 's-1', userId: 'u-1', groupId: 'g-1', lat: 1, lng: 2, type: 'breakdown', senderName: 'Red Leader' });
    // type defaults to 'general' when the stored pin predates the field
    expect(pins[1]).toMatchObject({ id: 's-2', userId: 'u-2', type: 'general', senderName: 'Bob' });
  });

  test('pins expired between the index and body lookups are skipped, as are malformed entries', async () => {
    const db = buildDb(['u-1', 'u-2', 'u-3'], [{ id: 'u-3', display_name: 'Cara', ptt_callsign: null }]);
    const redis = buildRedis({
      'sos:user:g-1:u-1': 's-expired',
      'sos:user:g-1:u-2': 's-bad',
      'sos:user:g-1:u-3': 's-ok',
      // 'sos:s-expired' absent — TTL fired between the two mgets
      'sos:s-bad': 'not json',
      'sos:s-ok': JSON.stringify({ userId: 'u-3', lat: 9, lng: 9, createdAt: '2026-07-14T00:00:00Z' }),
    });

    const pins = await getActiveGroupSos(db, redis, 'g-1');

    expect(pins).toHaveLength(1);
    expect(pins[0].id).toBe('s-ok');
  });

  test('group with no members or no active pins returns []', async () => {
    expect(await getActiveGroupSos(buildDb([], []), buildRedis({}), 'g-1')).toEqual([]);
    expect(await getActiveGroupSos(buildDb(['u-1'], []), buildRedis({}), 'g-1')).toEqual([]);
  });
});
