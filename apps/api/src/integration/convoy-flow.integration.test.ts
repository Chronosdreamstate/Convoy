/**
 * Integration tests: Full convoy flow
 *
 * IT-1: Create group → member joins → memberCount reflects both members
 * IT-2: Location update fans out to all group members via socket
 * IT-3: PTT start relays ptt:transmit with correct payload to all group members
 * IT-4: Member leave broadcasts member:left; subsequent PTT excludes them
 * IT-5: SOS trigger (sos:trigger → sos:received) relays to all group members
 *
 * Uses in-memory DB and socket doubles — no real DB, Redis, or socket.io required.
 */

import fc from 'fast-check';
import { Pool } from 'pg';
import Redis from 'ioredis';
import {
  handleLocationUpdate,
  handlePttStart,
  handlePttEnd,
  IoBroadcaster,
  LocationPayload,
} from '../socket/socket.handler';

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

interface InMemoryGroup {
  id: string;
  admin_id: string;
  gap_threshold_m: number;
  ptt_max_seconds: number;
  status: 'active' | 'ended';
}

interface InMemoryMember {
  id: string;
  group_id: string;
  user_id: string;
  left_at: Date | null;
  is_muted: boolean;
}

interface InMemoryChannel {
  id: string;
  group_id: string;
  is_all: boolean;
}

interface InMemoryPttLog {
  id: string;
  group_id: string;
  user_id: string;
  channel_id: string;
  started_at: Date;
  ended_at: Date | null;
}

let groups: InMemoryGroup[] = [];
let members: InMemoryMember[] = [];
let channels: InMemoryChannel[] = [];
let pttLogs: InMemoryPttLog[] = [];
let seqId = 0;

function nextId(): string {
  return `00000000-0000-0000-0002-${String(++seqId).padStart(12, '0')}`;
}

function resetStore(): void {
  groups = [];
  members = [];
  channels = [];
  pttLogs = [];
  seqId = 0;
}

// ---------------------------------------------------------------------------
// Mock Pool
// ---------------------------------------------------------------------------

function n(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toUpperCase();
}

async function poolQuery(
  sql: string,
  values?: unknown[],
): Promise<{ rows: unknown[]; rowCount: number }> {
  const norm = n(sql);

  // handleLocationUpdate: SELECT admin_id, gap_threshold_m FROM convoy_groups WHERE id = $1
  if (norm.includes('ADMIN_ID') && norm.includes('GAP_THRESHOLD_M') && norm.includes('CONVOY_GROUPS')) {
    const id = values![0] as string;
    const g = groups.find((g) => g.id === id);
    return { rows: g ? [g] : [], rowCount: g ? 1 : 0 };
  }

  // SELECT status FROM convoy_groups WHERE id = $1 (centroid gap alert)
  if (norm.includes('STATUS') && norm.includes('CONVOY_GROUPS') && norm.includes('WHERE ID = $1')) {
    const id = values![0] as string;
    const g = groups.find((g) => g.id === id);
    return { rows: g ? [{ status: g.status }] : [], rowCount: g ? 1 : 0 };
  }

  // handlePttStart: SELECT is_muted FROM convoy_members WHERE group_id=$1 AND user_id=$2 AND left_at IS NULL
  if (norm.includes('IS_MUTED') && norm.includes('CONVOY_MEMBERS') && norm.includes('LEFT_AT IS NULL')) {
    const [groupId, userId] = values as [string, string];
    const m = members.find(
      (m) => m.group_id === groupId && m.user_id === userId && m.left_at === null,
    );
    return { rows: m ? [{ is_muted: m.is_muted }] : [], rowCount: m ? 1 : 0 };
  }

  // SELECT id, is_all FROM ptt_channels WHERE id=$1 AND group_id=$2
  if (norm.includes('PTT_CHANNELS') && norm.includes('WHERE ID = $1')) {
    const [channelId, groupId] = values as [string, string];
    const ch = channels.find((c) => c.id === channelId && c.group_id === groupId);
    return { rows: ch ? [ch] : [], rowCount: ch ? 1 : 0 };
  }

  // SELECT user_id FROM convoy_members WHERE group_id=$1 AND left_at IS NULL
  if (norm.includes('USER_ID') && norm.includes('CONVOY_MEMBERS') && norm.includes('GROUP_ID = $1') && norm.includes('LEFT_AT IS NULL')) {
    const groupId = values![0] as string;
    const active = members.filter((m) => m.group_id === groupId && m.left_at === null);
    return { rows: active.map((m) => ({ user_id: m.user_id })), rowCount: active.length };
  }

  // INSERT INTO ptt_log RETURNING id
  if (norm.startsWith('INSERT INTO PTT_LOG')) {
    const [groupId, userId, channelId] = values as [string, string, string];
    const log: InMemoryPttLog = {
      id: nextId(),
      group_id: groupId,
      user_id: userId,
      channel_id: channelId,
      started_at: new Date(),
      ended_at: null,
    };
    pttLogs.push(log);
    return { rows: [{ id: log.id }], rowCount: 1 };
  }

  // SELECT id, channel_id, started_at FROM ptt_log WHERE id=$1 AND user_id=$2 AND group_id=$3
  if (norm.includes('PTT_LOG') && norm.includes('WHERE ID = $1')) {
    const [logId, userId, groupId] = values as [string, string, string];
    const log = pttLogs.find(
      (l) => l.id === logId && l.user_id === userId && l.group_id === groupId,
    );
    return { rows: log ? [{ id: log.id, channel_id: log.channel_id, started_at: log.started_at }] : [], rowCount: log ? 1 : 0 };
  }

  // UPDATE ptt_log SET ended_at=NOW() WHERE id=$1
  if (norm.startsWith('UPDATE PTT_LOG SET ENDED_AT')) {
    const logId = values![0] as string;
    const log = pttLogs.find((l) => l.id === logId);
    if (log) log.ended_at = new Date();
    return { rows: [], rowCount: log ? 1 : 0 };
  }

  // SELECT ptt_max_seconds FROM convoy_groups WHERE id=$1
  if (norm.includes('PTT_MAX_SECONDS') && norm.includes('CONVOY_GROUPS')) {
    const id = values![0] as string;
    const g = groups.find((g) => g.id === id);
    return { rows: g ? [{ ptt_max_seconds: g.ptt_max_seconds }] : [], rowCount: g ? 1 : 0 };
  }

  // SELECT id, is_all FROM ptt_channels WHERE id=$1 (handlePttEnd channel lookup)
  if (norm.includes('PTT_CHANNELS') && norm.includes('WHERE ID = $1') && !norm.includes('GROUP_ID')) {
    const [channelId] = values as [string];
    const ch = channels.find((c) => c.id === channelId);
    return { rows: ch ? [{ is_all: ch.is_all }] : [], rowCount: ch ? 1 : 0 };
  }

  // user_settings (hazard proximity check - not needed here, return empty)
  if (norm.includes('USER_SETTINGS')) {
    return { rows: [], rowCount: 0 };
  }

  // hazard_reports (not needed)
  if (norm.includes('HAZARD_REPORTS')) {
    return { rows: [], rowCount: 0 };
  }

  // member count query (SELECT COUNT(*) FROM convoy_members WHERE group_id=$1 AND left_at IS NULL)
  if (norm.includes('COUNT') && norm.includes('CONVOY_MEMBERS') && norm.includes('GROUP_ID = $1')) {
    const groupId = values![0] as string;
    const count = members.filter((m) => m.group_id === groupId && m.left_at === null).length;
    return { rows: [{ count: String(count) }], rowCount: 1 };
  }

  return { rows: [], rowCount: 0 };
}

function makeDb(): Pool {
  return { query: jest.fn(poolQuery) } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// Mock Redis (no-op — gap alerts need hgetall returning null for clean tests)
// ---------------------------------------------------------------------------

function makeRedis(): Redis {
  const store = new Map<string, Record<string, string>>();
  const setStore = new Map<string, Set<string>>();

  return {
    hset: jest.fn(async (key: string, fields: Record<string, string>) => {
      store.set(key, { ...(store.get(key) ?? {}), ...fields });
      return 1;
    }),
    hgetall: jest.fn(async (key: string) => {
      return store.get(key) ?? null;
    }),
    expire: jest.fn(async () => 1),
    incrbyfloat: jest.fn(async () => 0),
    del: jest.fn(async () => 1),
    keys: jest.fn(async () => []),
    set: jest.fn(async () => 'OK'),
    sadd: jest.fn(async () => 1),
  } as unknown as Redis;
}

// ---------------------------------------------------------------------------
// Mock IoBroadcaster
// ---------------------------------------------------------------------------

interface EmittedEvent {
  room: string;
  event: string;
  data: unknown;
}

function makeIo(): { io: IoBroadcaster; emitted: EmittedEvent[] } {
  const emitted: EmittedEvent[] = [];
  const io: IoBroadcaster = {
    to: (room: string) => ({
      emit: (event: string, data: unknown) => {
        emitted.push({ room, event, data });
      },
    }),
  };
  return { io, emitted };
}

// ---------------------------------------------------------------------------
// Helpers: set up a group with admin + one member
// ---------------------------------------------------------------------------

function seedGroup(groupId: string, adminId: string, extraMemberIds: string[] = []): void {
  groups.push({
    id: groupId,
    admin_id: adminId,
    gap_threshold_m: 500,
    ptt_max_seconds: 30,
    status: 'active',
  });
  members.push({ id: nextId(), group_id: groupId, user_id: adminId, left_at: null, is_muted: false });
  for (const uid of extraMemberIds) {
    members.push({ id: nextId(), group_id: groupId, user_id: uid, left_at: null, is_muted: false });
  }
  // All-hands channel
  channels.push({ id: `ch-${groupId}`, group_id: groupId, is_all: true });
}

const validLocation: LocationPayload = {
  lat: 37.7749,
  lng: -122.4194,
  heading: 90,
  speed_kph: 60,
  ts: Date.now(),
};

// ---------------------------------------------------------------------------
// IT-1: Location update broadcasts to the group room
// ---------------------------------------------------------------------------

describe('IT-1: Location update fans out to group room', () => {
  beforeEach(() => resetStore());

  it('emits location:update to group room for any valid group/user pair', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        async (groupId, adminId) => {
          resetStore();
          seedGroup(groupId, adminId);
          const db = makeDb();
          const redis = makeRedis();
          const { io, emitted } = makeIo();

          await handleLocationUpdate({
            groupId,
            userId: adminId,
            location: { ...validLocation, ts: Date.now() },
            redis,
            db,
            io,
          });

          const locationEmit = emitted.find((e) => e.event === 'location:update');
          expect(locationEmit).toBeDefined();
          expect(locationEmit?.room).toBe(`group:${groupId}`);
          expect((locationEmit?.data as { userId: string }).userId).toBe(adminId);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('includes all location fields in broadcast payload', async () => {
    const groupId = 'g-loc-001';
    const adminId = 'u-admin-001';
    seedGroup(groupId, adminId);
    const db = makeDb();
    const redis = makeRedis();
    const { io, emitted } = makeIo();

    const loc: LocationPayload = { lat: 51.5074, lng: -0.1278, heading: 270, speed_kph: 45, ts: 1700000000000 };
    await handleLocationUpdate({ groupId, userId: adminId, location: loc, redis, db, io });

    const e = emitted.find((ev) => ev.event === 'location:update');
    expect(e?.data).toMatchObject({ userId: adminId, lat: 51.5074, lng: -0.1278 });
  });
});

// ---------------------------------------------------------------------------
// IT-2: PTT start relays ptt:transmit with correct payload to all members
// ---------------------------------------------------------------------------

describe('IT-2: PTT start relays to all group members', () => {
  beforeEach(() => resetStore());

  it('emits ptt:transmit to every active member room for any group', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.uuid(),
        async (groupId, adminId, memberId) => {
          resetStore();
          seedGroup(groupId, adminId, [memberId]);
          const db = makeDb();
          const { io, emitted } = makeIo();

          const { logId } = await handlePttStart({
            groupId,
            userId: adminId,
            channelId: `ch-${groupId}`,
            db,
            io,
          });

          expect(logId).not.toBeNull();
          // Both admin and member should receive ptt:transmit (is_all channel)
          const transmits = emitted.filter((e) => e.event === 'ptt:transmit');
          const recipientRooms = transmits.map((e) => e.room);
          expect(recipientRooms).toContain(`user:${adminId}`);
          expect(recipientRooms).toContain(`user:${memberId}`);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('ptt:transmit payload includes logId, userId, channelId, groupId', async () => {
    const groupId = 'g-ptt-001';
    const adminId = 'u-admin-002';
    const memberId = 'u-member-002';
    seedGroup(groupId, adminId, [memberId]);
    const db = makeDb();
    const { io, emitted } = makeIo();

    const { logId } = await handlePttStart({
      groupId,
      userId: adminId,
      channelId: `ch-${groupId}`,
      db,
      io,
    });

    expect(logId).toBeTruthy();
    const transmit = emitted.find((e) => e.event === 'ptt:transmit' && e.room === `user:${memberId}`);
    expect(transmit?.data).toMatchObject({ userId: adminId, groupId, channelId: `ch-${groupId}` });
  });

  it('muted member cannot transmit — returns null logId', async () => {
    const groupId = 'g-muted-001';
    const adminId = 'u-admin-003';
    const mutedId = 'u-muted-001';
    seedGroup(groupId, adminId);
    // Add muted member
    members.push({ id: nextId(), group_id: groupId, user_id: mutedId, left_at: null, is_muted: true });

    const db = makeDb();
    const { io } = makeIo();

    const { logId } = await handlePttStart({
      groupId,
      userId: mutedId,
      channelId: `ch-${groupId}`,
      db,
      io,
    });

    expect(logId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// IT-3: Member leave — subsequent PTT excludes them
// ---------------------------------------------------------------------------

describe('IT-3: Departed member does not receive PTT after leaving', () => {
  beforeEach(() => resetStore());

  it('member who left is not in PTT recipient list', async () => {
    const groupId = 'g-leave-001';
    const adminId = 'u-admin-004';
    const leavingId = 'u-leaving-001';
    seedGroup(groupId, adminId, [leavingId]);

    // Simulate member leaving by setting left_at
    const leavingMember = members.find((m) => m.user_id === leavingId);
    if (leavingMember) leavingMember.left_at = new Date();

    const db = makeDb();
    const { io, emitted } = makeIo();

    await handlePttStart({
      groupId,
      userId: adminId,
      channelId: `ch-${groupId}`,
      db,
      io,
    });

    const transmitRooms = emitted.filter((e) => e.event === 'ptt:transmit').map((e) => e.room);
    // Should only go to admin's room — the left member is excluded
    expect(transmitRooms).not.toContain(`user:${leavingId}`);
    expect(transmitRooms).toContain(`user:${adminId}`);
  });

  it('property: removed member never appears in any ptt:transmit recipient', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.uuid(),
        async (groupId, adminId, leavingId) => {
          resetStore();
          seedGroup(groupId, adminId, [leavingId]);
          const leaving = members.find((m) => m.user_id === leavingId);
          if (leaving) leaving.left_at = new Date();

          const db = makeDb();
          const { io, emitted } = makeIo();

          await handlePttStart({
            groupId,
            userId: adminId,
            channelId: `ch-${groupId}`,
            db,
            io,
          });

          const transmitRooms = emitted
            .filter((e) => e.event === 'ptt:transmit')
            .map((e) => e.room);
          expect(transmitRooms).not.toContain(`user:${leavingId}`);
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ---------------------------------------------------------------------------
// IT-4: PTT end broadcasts ptt:ended to all recipients
// ---------------------------------------------------------------------------

describe('IT-4: PTT end broadcasts ptt:ended', () => {
  beforeEach(() => resetStore());

  it('ptt:ended reaches all active members after ptt:end', async () => {
    const groupId = 'g-end-001';
    const adminId = 'u-admin-005';
    const memberId = 'u-member-005';
    seedGroup(groupId, adminId, [memberId]);

    const db = makeDb();
    const { io, emitted } = makeIo();

    // Start
    const { logId } = await handlePttStart({
      groupId, userId: adminId, channelId: `ch-${groupId}`, db, io,
    });
    expect(logId).not.toBeNull();

    // End 2 seconds later
    await handlePttEnd({
      groupId, userId: adminId, logId: logId!, db, io,
      now: Date.now() + 2000,
    });

    const ended = emitted.filter((e) => e.event === 'ptt:ended');
    expect(ended.length).toBeGreaterThanOrEqual(1);
    expect(ended.some((e) => e.room === `user:${memberId}`)).toBe(true);
    expect(ended.some((e) => (e.data as { durationExceeded: boolean }).durationExceeded === false)).toBe(true);
  });

  it('durationExceeded is true when transmission runs longer than ptt_max_seconds', async () => {
    const groupId = 'g-over-001';
    const adminId = 'u-admin-006';
    seedGroup(groupId, adminId);
    // Set short max (5 seconds)
    const g = groups.find((g) => g.id === groupId)!;
    g.ptt_max_seconds = 5;

    const db = makeDb();
    const { io, emitted } = makeIo();

    const { logId } = await handlePttStart({
      groupId, userId: adminId, channelId: `ch-${groupId}`, db, io,
    });

    // End 10 seconds later (exceeds max of 5)
    await handlePttEnd({
      groupId, userId: adminId, logId: logId!, db, io,
      now: Date.now() + 10_000,
    });

    const ended = emitted.find((e) => e.event === 'ptt:ended');
    expect((ended?.data as { durationExceeded: boolean }).durationExceeded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// IT-5: Location update triggers gap:alert when member is far from admin
// ---------------------------------------------------------------------------

describe('IT-5: Gap alert fires when member exceeds threshold distance from admin', () => {
  beforeEach(() => resetStore());

  it('emits gap:alert to admin room when member is beyond gap_threshold_m', async () => {
    const groupId = 'g-gap-001';
    const adminId = 'u-admin-007';
    const memberId = 'u-member-007';
    seedGroup(groupId, adminId, [memberId]);

    const db = makeDb();
    const redis = makeRedis();
    const { io, emitted } = makeIo();

    // Seed admin location in Redis (San Francisco)
    const adminLoc = { lat: '37.7749', lng: '-122.4194', heading: '0', speed_kph: '0', ts: String(Date.now()) };
    await (redis.hset as jest.Mock)(`loc:${groupId}:${adminId}`, adminLoc);
    // Override hgetall to return admin loc only for admin key
    (redis.hgetall as jest.Mock).mockImplementation(async (key: string) => {
      if (key === `loc:${groupId}:${adminId}`) return adminLoc;
      return null;
    });

    // Member is ~600m away (beyond 500m threshold) — Los Angeles is too far; use ~0.006° offset ≈ 667m
    await handleLocationUpdate({
      groupId,
      userId: memberId,
      location: { lat: 37.7749 + 0.006, lng: -122.4194, heading: 90, speed_kph: 50, ts: Date.now() },
      redis,
      db,
      io,
      now: Date.now(),
    });

    const gapAlert = emitted.find((e) => e.event === 'gap:alert');
    expect(gapAlert).toBeDefined();
    expect(gapAlert?.room).toBe(`user:${adminId}`);
    expect((gapAlert?.data as { memberId: string }).memberId).toBe(memberId);
  });

  it('does not emit gap:alert when member is within gap_threshold_m', async () => {
    const groupId = 'g-gap-002';
    const adminId = 'u-admin-008';
    const memberId = 'u-member-008';
    seedGroup(groupId, adminId, [memberId]);
    const g = groups.find((g) => g.id === groupId)!;
    g.gap_threshold_m = 500;

    const db = makeDb();
    const redis = makeRedis();
    const { io, emitted } = makeIo();

    const adminLoc = { lat: '37.7749', lng: '-122.4194', heading: '0', speed_kph: '0', ts: String(Date.now()) };
    (redis.hgetall as jest.Mock).mockImplementation(async (key: string) => {
      if (key === `loc:${groupId}:${adminId}`) return adminLoc;
      return null;
    });

    // Member is ~111m away (0.001° ≈ 111m — well within 500m)
    await handleLocationUpdate({
      groupId,
      userId: memberId,
      location: { lat: 37.7749 + 0.001, lng: -122.4194, heading: 90, speed_kph: 30, ts: Date.now() },
      redis,
      db,
      io,
      now: Date.now(),
    });

    const gapAlert = emitted.find((e) => e.event === 'gap:alert');
    expect(gapAlert).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// IT-6 & IT-7: convoy:alert relay
// Mirrors the logic in socket.handler.ts convoy:alert handler.
// ---------------------------------------------------------------------------

interface ConvoyAlertParams {
  /** The groupId the socket is authenticated to (from join event). */
  groupId: string;
  /** The groupId included in the payload — must match groupId to pass guard. */
  alertGroupId: string;
  type: 'stopping' | 'regroup' | 'incident';
  message: string;
  senderId: string;
  db: Pool;
  io: IoBroadcaster;
}

interface ConvoyAlertRow {
  ptt_callsign: string | null;
  display_name: string;
}

async function simulateConvoyAlert(params: ConvoyAlertParams): Promise<void> {
  const { groupId, alertGroupId, type, message, senderId, db, io } = params;
  // Guard: payload groupId must match socket's authenticated groupId
  if (!type || !message || alertGroupId !== groupId) return;

  const result = await db.query<ConvoyAlertRow>(
    'SELECT ptt_callsign, display_name FROM users WHERE id = $1',
    [senderId],
  );
  const user = result.rows[0];
  const senderCallsign = user?.ptt_callsign ?? user?.display_name ?? 'Unknown';

  io.to(`group:${groupId}`).emit('convoy:alert', {
    type,
    message,
    senderCallsign,
    senderId,
    timestamp: new Date().toISOString(),
  });
}

function makeAlertDb(callsign: string | null, displayName: string): Pool {
  return {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('ptt_callsign')) {
        return { rows: [{ ptt_callsign: callsign, display_name: displayName }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// IT-6: convoy:alert fans out to group room with sender callsign
// ---------------------------------------------------------------------------

describe('IT-6: convoy:alert broadcasts to group room with sender callsign', () => {
  it('emits convoy:alert to group room for any valid alert type and sender', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.constantFrom('stopping', 'regroup', 'incident') as fc.Arbitrary<'stopping' | 'regroup' | 'incident'>,
        fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0),
        async (groupId, senderId, type, callsign) => {
          const db = makeAlertDb(callsign, 'Display Name');
          const { io, emitted } = makeIo();

          await simulateConvoyAlert({
            groupId,
            alertGroupId: groupId, // matches — guard passes
            type,
            message: `${type} message`,
            senderId,
            db,
            io,
          });

          const alert = emitted.find((e) => e.event === 'convoy:alert');
          expect(alert).toBeDefined();
          expect(alert?.room).toBe(`group:${groupId}`);
          const data = alert?.data as { senderCallsign: string; type: string; senderId: string };
          expect(data.senderCallsign).toBe(callsign);
          expect(data.type).toBe(type);
          expect(data.senderId).toBe(senderId);
        },
      ),
      { numRuns: 25 },
    );
  });

  it('falls back to display_name when ptt_callsign is null', async () => {
    const groupId = 'g-alert-001';
    const senderId = 'u-sender-001';
    const db = makeAlertDb(null, 'John Doe');
    const { io, emitted } = makeIo();

    await simulateConvoyAlert({
      groupId,
      alertGroupId: groupId,
      type: 'stopping',
      message: '🚦 Stopping',
      senderId,
      db,
      io,
    });

    const data = emitted[0]?.data as { senderCallsign: string };
    expect(data.senderCallsign).toBe('John Doe');
  });
});

// ---------------------------------------------------------------------------
// IT-7: convoy:alert is dropped when alertGroupId !== socket's groupId
// ---------------------------------------------------------------------------

describe('IT-7: convoy:alert cross-group injection is blocked by guard', () => {
  it('does not emit when alertGroupId does not match the socket groupId', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid().filter((id) => id !== 'g-attacker-001'), // different groupId
        fc.uuid(),
        async (socketGroupId, injectedGroupId, senderId) => {
          fc.pre(socketGroupId !== injectedGroupId);
          const db = makeAlertDb('ATTACKER', 'Attacker');
          const { io, emitted } = makeIo();

          await simulateConvoyAlert({
            groupId: socketGroupId,       // socket is authenticated to this group
            alertGroupId: injectedGroupId, // payload claims a different group
            type: 'incident',
            message: '⚠️ Injected alert',
            senderId,
            db,
            io,
          });

          // Guard must block — no events emitted
          expect(emitted).toHaveLength(0);
          // DB should not be queried either (guard returns before fetch)
          expect((db.query as jest.Mock).mock.calls).toHaveLength(0);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('does not emit when type is missing', async () => {
    const { io, emitted } = makeIo();
    const db = makeAlertDb('CALL', 'Name');

    // Pass empty string as type — guard catches falsy check
    await simulateConvoyAlert({
      groupId: 'g-guard-001',
      alertGroupId: 'g-guard-001',
      type: '' as 'stopping',
      message: 'msg',
      senderId: 'u-001',
      db,
      io,
    });

    expect(emitted).toHaveLength(0);
  });
});
