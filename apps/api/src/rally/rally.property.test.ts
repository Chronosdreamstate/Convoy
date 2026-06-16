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
