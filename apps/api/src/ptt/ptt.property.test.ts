/**
 * Property 15: PTT restricted to active group Members
 *   canTransmit returns false for non-members regardless of mute state.
 *   Validates: Requirement 10.1
 *
 * Property 16: PTT transmission duration never exceeds configured limit
 *   isDurationExceeded(startedAtMs, nowMs, maxSeconds) is true when elapsed >= limit.
 *   Validates: Requirements 10.5, 10.6
 *
 * Property 17: Muted Member cannot transmit PTT audio
 *   canTransmit returns false whenever isMuted is true.
 *   Validates: Requirements 10.10, 10.11
 *
 * Property 42: "All" PTT channel is indestructible
 *   canDeleteChannel returns false for any channel where is_all = true.
 *   Validates: Requirement 26.2
 *
 * Property 43: PTT transmission is scoped to channel recipients
 *   getChannelRecipients with isAllChannel=false returns only channelMemberIds.
 *   Validates: Requirement 26.4
 *
 * Property 44: "All" channel delivers to every Member
 *   getChannelRecipients with isAllChannel=true returns allMemberIds.
 *   Validates: Requirement 26.5
 *
 * Property 45: Each Member belongs to exactly one PTT channel at a time
 *   enforceExactlyOneChannel always produces a Map with exactly one entry per userId.
 *   Validates: Requirement 26.6
 *
 * Property 46: PTT_Log records every transmission event
 *   handlePttStart inserts exactly one ptt_log row when canTransmit is true.
 *   Validates: Requirement 27.1
 *
 * Property 47: PTT_Log is accessible to all group Members (403 to non-Members)
 *   canViewPttLog returns true iff isActiveMember is true.
 *   Validates: Requirement 27.2
 *
 * Property 48: PTT_Log is cleared on session end
 *   cleanupGroupPttLog deletes all rows for that group from a mock store.
 *   Validates: Requirement 27.4
 *
 * Property 49: PTT_Log entries are in ascending chronological order
 *   sortPttLogAscending always returns entries sorted by startedAt asc.
 *   Validates: Requirement 27.5
 */

import fc from 'fast-check';
import {
  canTransmit,
  isDurationExceeded,
  canDeleteChannel,
  getChannelRecipients,
  enforceExactlyOneChannel,
  canViewPttLog,
  sortPttLogAscending,
  userIdToAgoraUid,
} from './ptt.routes';
import { handlePttStart } from '../socket/socket.handler';
import { cleanupGroupPttLog } from '../groups/groups.routes';
import { Pool } from 'pg';
import { IoBroadcaster } from '../socket/socket.handler';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const uuidArb = fc.tuple(
  fc.hexaString({ minLength: 8, maxLength: 8 }),
  fc.hexaString({ minLength: 4, maxLength: 4 }),
  fc.hexaString({ minLength: 4, maxLength: 4 }),
  fc.hexaString({ minLength: 4, maxLength: 4 }),
  fc.hexaString({ minLength: 12, maxLength: 12 }),
).map(([a, b, c, d, e]) => `${a}-${b}-${c}-${d}-${e}`);

const epochArb = fc.integer({ min: 0, max: 2_000_000_000_000 });

// ---------------------------------------------------------------------------
// Property 15: PTT restricted to active group Members
// ---------------------------------------------------------------------------

describe('Property 15: PTT restricted to active group Members', () => {
  it('canTransmit is false when isActiveMember is false, regardless of mute', () => {
    fc.assert(
      fc.property(fc.boolean(), (isMuted) => {
        expect(canTransmit({ isActiveMember: false, isMuted })).toBe(false);
      }),
      { numRuns: 50 },
    );
  });

  it('canTransmit is true only when isActiveMember=true AND isMuted=false', () => {
    expect(canTransmit({ isActiveMember: true, isMuted: false })).toBe(true);
    expect(canTransmit({ isActiveMember: true, isMuted: true })).toBe(false);
    expect(canTransmit({ isActiveMember: false, isMuted: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property 16: PTT transmission duration never exceeds configured limit
// ---------------------------------------------------------------------------

describe('Property 16: PTT transmission duration never exceeds configured limit', () => {
  it('isDurationExceeded is true when elapsed >= maxSeconds', () => {
    fc.assert(
      fc.property(
        epochArb,
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 0, max: 5000 }),
        (startedAt, maxSeconds, extraMs) => {
          const now = startedAt + maxSeconds * 1000 + extraMs;
          expect(isDurationExceeded(startedAt, now, maxSeconds)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('isDurationExceeded is false when elapsed < maxSeconds', () => {
    fc.assert(
      fc.property(
        epochArb,
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 1, max: 999 }),
        (startedAt, maxSeconds, shortMs) => {
          const now = startedAt + maxSeconds * 1000 - shortMs;
          expect(isDurationExceeded(startedAt, now, maxSeconds)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('exactly at the limit (elapsed === maxSeconds * 1000) → exceeded', () => {
    expect(isDurationExceeded(0, 30_000, 30)).toBe(true);
    expect(isDurationExceeded(0, 29_999, 30)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property 17: Muted Member cannot transmit PTT audio
// ---------------------------------------------------------------------------

describe('Property 17: Muted Member cannot transmit PTT audio', () => {
  it('canTransmit is always false when isMuted=true, regardless of membership', () => {
    fc.assert(
      fc.property(fc.boolean(), (isActiveMember) => {
        expect(canTransmit({ isActiveMember, isMuted: true })).toBe(false);
      }),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 42: "All" PTT channel is indestructible
// ---------------------------------------------------------------------------

describe('Property 42: "All" PTT channel is indestructible', () => {
  it('canDeleteChannel is false for any channel with is_all=true', () => {
    fc.assert(
      fc.property(fc.constant(true), (isAll) => {
        expect(canDeleteChannel({ is_all: isAll })).toBe(false);
      }),
      { numRuns: 10 },
    );
  });

  it('canDeleteChannel is true for non-all channels', () => {
    expect(canDeleteChannel({ is_all: false })).toBe(true);
    expect(canDeleteChannel({ is_all: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property 43: PTT transmission is scoped to channel recipients
// ---------------------------------------------------------------------------

describe('Property 43: PTT transmission is scoped to channel recipients', () => {
  it('non-all channel returns exactly channelMemberIds (not allMemberIds)', () => {
    fc.assert(
      fc.property(
        fc.array(uuidArb, { minLength: 2, maxLength: 6 }),
        fc.array(uuidArb, { minLength: 1, maxLength: 3 }),
        (allMembers, channelMembers) => {
          const recipients = getChannelRecipients(allMembers, channelMembers, false);
          expect(recipients).toEqual(channelMembers);
          expect(recipients).not.toBe(channelMembers); // must be a copy
        },
      ),
      { numRuns: 50 },
    );
  });

  it('members outside the channel do not receive non-all PTT', () => {
    const allMembers = ['u1', 'u2', 'u3', 'u4'];
    const channelMembers = ['u1', 'u3'];
    const recipients = getChannelRecipients(allMembers, channelMembers, false);
    expect(recipients).toContain('u1');
    expect(recipients).toContain('u3');
    expect(recipients).not.toContain('u2');
    expect(recipients).not.toContain('u4');
  });
});

// ---------------------------------------------------------------------------
// Property 44: "All" channel delivers to every Member
// ---------------------------------------------------------------------------

describe('Property 44: "All" channel delivers to every Member', () => {
  it('all-channel returns allMemberIds regardless of channelMemberIds', () => {
    fc.assert(
      fc.property(
        fc.array(uuidArb, { minLength: 1, maxLength: 8 }),
        fc.array(uuidArb, { minLength: 0, maxLength: 3 }),
        (allMembers, channelMembers) => {
          const recipients = getChannelRecipients(allMembers, channelMembers, true);
          expect(recipients).toEqual(allMembers);
          expect(recipients.length).toBe(allMembers.length);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('all-channel with empty channelMembers still delivers to all', () => {
    const allMembers = ['u1', 'u2', 'u3'];
    const recipients = getChannelRecipients(allMembers, [], true);
    expect(recipients).toEqual(['u1', 'u2', 'u3']);
  });
});

// ---------------------------------------------------------------------------
// Property 45: Each Member belongs to exactly one PTT channel at a time
// ---------------------------------------------------------------------------

describe('Property 45: Each Member belongs to exactly one PTT channel at a time', () => {
  it('enforceExactlyOneChannel produces a Map with exactly one channel per user', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ userId: uuidArb, channelId: uuidArb }),
          { minLength: 1, maxLength: 10 },
        ),
        uuidArb,
        uuidArb,
        (initialPairs, targetUser, newChannelId) => {
          let memberships = new Map<string, string>();
          for (const { userId, channelId } of initialPairs) {
            memberships = enforceExactlyOneChannel(memberships, userId, channelId);
          }

          // Switch targetUser to a new channel
          const updated = enforceExactlyOneChannel(memberships, targetUser, newChannelId);

          // Exactly one entry for targetUser
          expect(updated.get(targetUser)).toBe(newChannelId);
          // Total count of targetUser entries is exactly 1 (Map guarantees this)
          let targetCount = 0;
          updated.forEach((_, k) => { if (k === targetUser) targetCount++; });
          expect(targetCount).toBe(1);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('joining a new channel removes the old channel assignment', () => {
    let memberships = new Map<string, string>();
    memberships = enforceExactlyOneChannel(memberships, 'user-1', 'channel-a');
    expect(memberships.get('user-1')).toBe('channel-a');

    const updated = enforceExactlyOneChannel(memberships, 'user-1', 'channel-b');
    expect(updated.get('user-1')).toBe('channel-b');
    // Original map is not mutated
    expect(memberships.get('user-1')).toBe('channel-a');
  });
});

// ---------------------------------------------------------------------------
// Property 46: PTT_Log records every transmission event
// ---------------------------------------------------------------------------

describe('Property 46: PTT_Log records every transmission event', () => {
  function makeMockPool(opts: {
    isMember?: boolean;
    isMuted?: boolean;
    isAllChannel?: boolean;
    members?: string[];
    channelMembers?: string[];
  }): { pool: Pool; insertedLogs: string[] } {
    const insertedLogs: string[] = [];
    const {
      isMember = true,
      isMuted = false,
      isAllChannel = false,
      members = ['user-1', 'user-2'],
      channelMembers = ['user-1'],
    } = opts;

    const pool = {
      query: async (text: string, _values: unknown[]) => {
        const t = text.replace(/\s+/g, ' ').toLowerCase();
        if (t.includes('from convoy_members') && t.includes('user_id = $2')) {
          return { rows: isMember ? [{ is_muted: isMuted }] : [], rowCount: isMember ? 1 : 0 };
        }
        if (t.includes('from ptt_channels') && t.includes('where id = $1')) {
          return { rows: [{ id: 'ch-1', is_all: isAllChannel }], rowCount: 1 };
        }
        if (t.includes('from convoy_members') && !t.includes('user_id = $2')) {
          return { rows: members.map((u) => ({ user_id: u })), rowCount: members.length };
        }
        if (t.includes('from ptt_channel_members')) {
          return { rows: channelMembers.map((u) => ({ user_id: u })), rowCount: channelMembers.length };
        }
        if (t.includes('insert into ptt_log')) {
          const logId = `log-${insertedLogs.length + 1}`;
          insertedLogs.push(logId);
          return { rows: [{ id: logId }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;

    return { pool, insertedLogs };
  }

  function makeMockIO(): { io: IoBroadcaster; emissions: Array<{ room: string; event: string }> } {
    const emissions: Array<{ room: string; event: string }> = [];
    const io: IoBroadcaster = {
      to: (room) => ({
        emit: (event) => { emissions.push({ room, event }); },
      }),
    };
    return { io, emissions };
  }

  it('inserts exactly one ptt_log row per ptt:start when member can transmit', async () => {
    await fc.assert(
      fc.asyncProperty(uuidArb, uuidArb, uuidArb, async (groupId, userId, channelId) => {
        const { pool, insertedLogs } = makeMockPool({ isMember: true, isMuted: false });
        const { io } = makeMockIO();

        const result = await handlePttStart({ groupId, userId, channelId, db: pool, io });

        expect(result.logId).not.toBeNull();
        expect(insertedLogs).toHaveLength(1);
      }),
      { numRuns: 20 },
    );
  });

  it('does NOT insert ptt_log when member cannot transmit (muted)', async () => {
    const { pool, insertedLogs } = makeMockPool({ isMember: true, isMuted: true });
    const { io } = makeMockIO();

    const result = await handlePttStart({
      groupId: 'g-1', userId: 'u-1', channelId: 'ch-1', db: pool, io,
    });

    expect(result.logId).toBeNull();
    expect(insertedLogs).toHaveLength(0);
  });

  it('does NOT insert ptt_log when user is not a member', async () => {
    const { pool, insertedLogs } = makeMockPool({ isMember: false });
    const { io } = makeMockIO();

    const result = await handlePttStart({
      groupId: 'g-1', userId: 'u-1', channelId: 'ch-1', db: pool, io,
    });

    expect(result.logId).toBeNull();
    expect(insertedLogs).toHaveLength(0);
  });

  it('broadcasts ptt:transmit to recipients on successful start', async () => {
    const { pool } = makeMockPool({
      isMember: true, isMuted: false, isAllChannel: false, channelMembers: ['u-1', 'u-2'],
    });
    const { io, emissions } = makeMockIO();

    await handlePttStart({ groupId: 'g-1', userId: 'u-tx', channelId: 'ch-1', db: pool, io });

    const pttEmissions = emissions.filter((e) => e.event === 'ptt:transmit');
    expect(pttEmissions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Property 47: PTT_Log is accessible to all group Members
// ---------------------------------------------------------------------------

describe('Property 47: PTT_Log is accessible to all group Members', () => {
  it('canViewPttLog returns true for active members, false for non-members', () => {
    fc.assert(
      fc.property(fc.boolean(), (isActiveMember) => {
        expect(canViewPttLog(isActiveMember)).toBe(isActiveMember);
      }),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 48: PTT_Log is cleared on session end
// ---------------------------------------------------------------------------

describe('Property 48: PTT_Log is cleared on session end', () => {
  it('cleanupGroupPttLog deletes all rows for the group', async () => {
    await fc.assert(
      fc.asyncProperty(uuidArb, fc.array(uuidArb, { minLength: 0, maxLength: 5 }), async (groupId, otherGroups) => {
        const deleted: string[] = [];
        const mockClient = {
          query: async (text: string, values: unknown[]) => {
            if (text.toLowerCase().includes('delete from ptt_log')) {
              deleted.push(values[0] as string);
            }
            return { rows: [], rowCount: 0 };
          },
        };

        await cleanupGroupPttLog(groupId, mockClient);

        expect(deleted).toHaveLength(1);
        expect(deleted[0]).toBe(groupId);
      }),
      { numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 49: PTT_Log entries are in ascending chronological order
// ---------------------------------------------------------------------------

describe('Property 49: PTT_Log entries are in ascending chronological order', () => {
  const logEntryArb = fc.record({
    id: uuidArb,
    userId: uuidArb,
    startedAt: epochArb,
    displayName: fc.string({ minLength: 1, maxLength: 30 }),
  });

  it('sortPttLogAscending always produces startedAt ascending order', () => {
    fc.assert(
      fc.property(fc.array(logEntryArb, { minLength: 0, maxLength: 20 }), (entries) => {
        const sorted = sortPttLogAscending(entries);
        for (let i = 1; i < sorted.length; i++) {
          expect(sorted[i].startedAt).toBeGreaterThanOrEqual(sorted[i - 1].startedAt);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('sortPttLogAscending does not mutate the original array', () => {
    const entries = [
      { id: '1', userId: 'u', startedAt: 3000, displayName: 'C' },
      { id: '2', userId: 'u', startedAt: 1000, displayName: 'A' },
      { id: '3', userId: 'u', startedAt: 2000, displayName: 'B' },
    ];
    const original = [...entries];
    sortPttLogAscending(entries);
    expect(entries).toEqual(original);
  });

  it('empty log returns empty array', () => {
    expect(sortPttLogAscending([])).toEqual([]);
  });

  it('single entry returns as-is', () => {
    const entry = { id: '1', userId: 'u', startedAt: 5000, displayName: 'X' };
    expect(sortPttLogAscending([entry])).toEqual([entry]);
  });
});

// ---------------------------------------------------------------------------
// Sanity test for userIdToAgoraUid
// ---------------------------------------------------------------------------

describe('userIdToAgoraUid', () => {
  it('always returns a non-zero uint32', () => {
    fc.assert(
      fc.property(uuidArb, (userId) => {
        const uid = userIdToAgoraUid(userId);
        expect(uid).toBeGreaterThan(0);
        expect(uid).toBeLessThanOrEqual(0xFFFFFFFF);
        expect(Number.isInteger(uid)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('is deterministic — same userId always produces same uid', () => {
    const userId = '550e8400-e29b-41d4-a716-446655440000';
    expect(userIdToAgoraUid(userId)).toBe(userIdToAgoraUid(userId));
  });
});
