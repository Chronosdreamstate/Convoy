/**
 * Handshake authorization for the WebSocket.
 *
 * This is the ONLY authorization the socket performs against the group a client
 * claims in `auth.groupId`, so there is no second line of defence behind it.
 *
 * The hole it closes: DM threads are convoy_groups rows with real
 * convoy_members entries, so the original membership-only check accepted a DM
 * id as a valid "active convoy". socket.handler.ts then fanned the user's live
 * GPS into `group:<dmId>` — a room both participants join on connect — turning
 * a text conversation into a continuous position feed for the other person,
 * with no convoy involved and without the share_location_with_friends opt-in.
 */

import jwt from 'jsonwebtoken';
import type { Pool } from 'pg';
import { env } from '../config/env';
import { authorizeHandshake } from './socketio';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONVOY_ID = '22222222-2222-4222-8222-222222222222';
const DM_ID = '33333333-3333-4333-8333-333333333333';

function signToken(sub: string = USER_ID): string {
  return jwt.sign({ sub }, env.JWT_SECRET, { expiresIn: '15m' });
}

/**
 * Stands in for the real membership query. `rows` is non-empty only when the
 * group is one the real SQL would match — an active membership in a non-DM
 * group — which is exactly the behaviour under test.
 */
function buildDb(opts: { memberOf?: string[]; dmGroups?: string[] } = {}): {
  pool: Pool;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const memberOf = new Set(opts.memberOf ?? []);
  const dmGroups = new Set(opts.dmGroups ?? []);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      const [groupId, userId] = params as [string, string];
      const active = userId === USER_ID && memberOf.has(groupId);
      const isDm = dmGroups.has(groupId);
      // The `g.type <> 'dm'` clause is what the real query adds; mirror it.
      const matches = active && !isDm && /g\.type <> 'dm'/.test(sql);
      return { rows: matches ? [{ id: 'member-row' }] : [] };
    },
  } as unknown as Pool;
  return { pool, calls };
}

describe('authorizeHandshake', () => {
  it('rejects a missing or malformed token', async () => {
    const db = buildDb();
    expect(await authorizeHandshake(db.pool, undefined, '')).toBeNull();
    expect(await authorizeHandshake(db.pool, 'not-a-jwt', '')).toBeNull();
    // A token signed with the wrong secret must not be trusted either.
    const forged = jwt.sign({ sub: USER_ID }, 'some-other-secret-that-is-long-enough!!');
    expect(await authorizeHandshake(db.pool, forged, '')).toBeNull();
  });

  it('admits a valid token with no claimed group', async () => {
    // IdleMapScreen connects exactly like this — no groupId at all — so that it
    // still receives a friend's standalone SOS in its personal room.
    const db = buildDb();
    expect(await authorizeHandshake(db.pool, signToken(), undefined)).toEqual({
      userId: USER_ID,
      groupId: '',
    });
    expect(db.calls).toHaveLength(0); // nothing to check
  });

  it('admits a convoy the user is an active member of', async () => {
    const db = buildDb({ memberOf: [CONVOY_ID] });
    expect(await authorizeHandshake(db.pool, signToken(), CONVOY_ID)).toEqual({
      userId: USER_ID,
      groupId: CONVOY_ID,
    });
  });

  it('rejects a group the user is not a member of', async () => {
    const db = buildDb({ memberOf: [CONVOY_ID] });
    expect(await authorizeHandshake(db.pool, signToken(), 'a-group-i-am-not-in')).toBeNull();
  });

  it('rejects a DM thread the user IS a member of', async () => {
    // The heart of it: membership alone is TRUE here — both participants are
    // real convoy_members of the DM's convoy_groups row. Accepting it is what
    // turned the DM room into a live GPS feed for the other participant.
    const db = buildDb({ memberOf: [CONVOY_ID, DM_ID], dmGroups: [DM_ID] });

    expect(await authorizeHandshake(db.pool, signToken(), DM_ID)).toBeNull();

    // ...while the user's real convoy is unaffected.
    expect(await authorizeHandshake(db.pool, signToken(), CONVOY_ID)).toEqual({
      userId: USER_ID,
      groupId: CONVOY_ID,
    });
  });
});
