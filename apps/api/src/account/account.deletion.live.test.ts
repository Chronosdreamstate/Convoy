/**
 * LIVE account-deletion suite — proves that DELETE /account actually completes
 * against the REAL migrated schema for a user who has touched every table that
 * references users(id).
 *
 * This is a class of bug the in-memory pool in account.property.test.ts can
 * never catch: the mock has no foreign keys, so a route that leaves a row
 * pointing at the user it is about to delete "passes" there and aborts the
 * whole transaction in production with
 *   "update or delete on table users violates foreign key constraint ..."
 * — i.e. a 500 on every retry and an account that can never be deleted.
 *
 * ── HOW TO RUN ──────────────────────────────────────────────────────────────
 *   1. docker compose up -d      (from the repo root — starts convoy_postgres)
 *   2. cd apps/api
 *   3. pnpm test src/account/account.deletion.live.test.ts
 *   Skips itself cleanly when Postgres is unreachable (same gate as
 *   src/integration/schema.contract.live.test.ts).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import type { Redis } from 'ioredis';

// DELETE /account removes the account's uploaded files through the shared
// storage backend, which resolves UPLOADS_DIR once at config-load time. Point
// it at a scratch directory BEFORE the route module (and through it
// uploads/storage -> config/env) is first loaded — hence `require` here rather
// than a hoisted `import`.
const UPLOADS_DIR = path.join(os.tmpdir(), `convoy-account-deletion-${process.pid}`);
process.env.UPLOADS_DIR = UPLOADS_DIR;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const accountRoutes: FastifyPluginAsync = require('./account.routes').default;

// ---------------------------------------------------------------------------
// Infra gate (same TCP-probe approach as integration/schema.contract.live.test.ts)
// ---------------------------------------------------------------------------

const PG_HOST = process.env.LIVE_SMOKE_PG_HOST ?? 'localhost';
const PG_PORT = Number(process.env.LIVE_SMOKE_PG_PORT ?? 5432);
const PG_USER = 'convoy';
const PG_PASSWORD = 'convoy';
const SCRATCH_DB = 'convoy_account_deletion';
const SCRATCH_URL = `postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`;

function tcpReachable(host: string, port: number): boolean {
  const script =
    'const s=require("net").connect({host:process.argv[1],port:Number(process.argv[2])});' +
    's.setTimeout(1500);' +
    's.on("connect",()=>{s.destroy();process.exit(0);});' +
    's.on("timeout",()=>process.exit(1));' +
    's.on("error",()=>process.exit(1));';
  const res = spawnSync(process.execPath, ['-e', script, host, String(port)], { timeout: 6000 });
  return res.status === 0;
}

const infraUp = process.env.LIVE_SMOKE !== '0' && tcpReachable(PG_HOST, PG_PORT);
const describeLive = infraUp ? describe : describe.skip;

if (!infraUp) {
  // eslint-disable-next-line no-console
  console.warn(
    `[account.deletion.live] Postgres (${PG_HOST}:${PG_PORT}) not reachable — skipping. ` +
      'Start docker compose to enable it.',
  );
}

// ---------------------------------------------------------------------------
// Scratch database helpers
// ---------------------------------------------------------------------------

async function openAdminPool(): Promise<Pool> {
  for (const db of ['postgres', 'convoy']) {
    const pool = new Pool({
      connectionString: `postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${db}`,
      max: 1,
    });
    try {
      await pool.query('SELECT 1');
      return pool;
    } catch {
      await pool.end().catch(() => undefined);
    }
  }
  throw new Error('Could not open an admin connection to Postgres');
}

async function recreateScratchDatabase(): Promise<void> {
  const admin = await openAdminPool();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  } finally {
    await admin.end();
  }
}

async function dropScratchDatabase(): Promise<void> {
  const admin = await openAdminPool();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/** Applies src/db/migrations/*.sql in order — same algorithm as src/db/migrate.ts. */
async function migrateScratchDatabase(): Promise<void> {
  const migrationsDir = path.resolve(__dirname, '..', 'db', 'migrations');
  const pool = new Pool({ connectionString: SCRATCH_URL, max: 1 });
  const client = await pool.connect();
  try {
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const filename of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf-8');
      await client.query(sql);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// App under test — REAL account routes, REAL pool
// ---------------------------------------------------------------------------

let pool: Pool;
let app: FastifyInstance;
let deletedRedisKeys: string[];
let emissions: Array<{ room: string; event: string; data: unknown }>;
let disconnectedRooms: string[];

/** Minimal Redis double: DELETE /account only ever calls `del`. */
function redisDouble(): Redis {
  return {
    del: (...keys: string[]) => {
      deletedRedisKeys.push(...keys);
      return Promise.resolve(keys.length);
    },
  } as unknown as Redis;
}

/** socket.io double recording room broadcasts and forced disconnects. */
function ioDouble() {
  return {
    to: (room: string) => ({
      emit: (event: string, data: unknown) => { emissions.push({ room, event, data }); },
    }),
    in: (room: string) => ({
      disconnectSockets: () => { disconnectedRooms.push(room); },
    }),
  };
}

function buildApp(): FastifyInstance {
  const instance = Fastify({ logger: false });
  instance.register(fastifyCookie);
  instance.register(fastifyJwt, {
    secret: 'test-secret-that-is-at-least-32-chars-long!!',
    sign: { expiresIn: '15m' },
  });
  instance.register(fastifySensible);
  instance.register(fp(async (i) => { i.decorate('db', pool); }, { name: 'db' }));
  // generalLimiter no-ops under NODE_ENV=test, so no other Redis calls happen.
  instance.register(fp(async (i) => { i.decorate('redis', redisDouble()); }, { name: 'redis' }));
  instance.register(fp(async (i) => { i.decorate('io', ioDouble() as never); }, { name: 'io' }));
  instance.register(accountRoutes, { prefix: '/api/v1' });
  return instance;
}

async function createUser(name: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO users (display_name) VALUES ($1) RETURNING id`,
    [name],
  );
  return res.rows[0].id;
}

async function createGroup(adminId: string, joinCode: string, accessType = 'open'): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO convoy_groups (name, join_code, admin_id, access_type)
     VALUES ('Test Convoy', $1, $2, $3) RETURNING id`,
    [joinCode, adminId, accessType],
  );
  return res.rows[0].id;
}

async function addMember(groupId: string, userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO convoy_members (group_id, user_id) VALUES ($1, $2)
     ON CONFLICT (group_id, user_id) DO NOTHING`,
    [groupId, userId],
  );
}

function tokenFor(userId: string): string {
  return app.jwt.sign({ sub: userId });
}

async function deleteAccount(userId: string) {
  return app.inject({
    method: 'DELETE',
    url: '/api/v1/account',
    headers: { Authorization: `Bearer ${tokenFor(userId)}` },
  });
}

describeLive('live: DELETE /account completes for a user with data everywhere', () => {
  beforeAll(async () => {
    await recreateScratchDatabase();
    await migrateScratchDatabase();
    pool = new Pool({ connectionString: SCRATCH_URL, max: 4 });
    app = buildApp();
    await app.ready();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await dropScratchDatabase();
    fs.rmSync(UPLOADS_DIR, { recursive: true, force: true });
  }, 60_000);

  beforeEach(() => {
    deletedRedisKeys = [];
    emissions = [];
    disconnectedRooms = [];
  });

  // -------------------------------------------------------------------------
  // group_join_requests.resolved_by (migration 027) had no ON DELETE action.
  // -------------------------------------------------------------------------
  it('deletes the account of an admin who has approved a join request', async () => {
    // Real-world shape: Ada runs an invite-only convoy, Ben asks to join, Ada
    // taps Approve (group_join_requests.resolved_by = Ada), then later opens
    // Settings → Delete Account. Before migration 037 the surviving
    // group_join_requests row pinned Ada's users row, so `DELETE FROM users`
    // raised group_join_requests_resolved_by_fkey, the whole transaction rolled
    // back and the request 500'd — every single time. Ada's account could never
    // be deleted.
    const ada = await createUser('Ada');
    const ben = await createUser('Ben');
    const groupId = await createGroup(ada, 'AAA111', 'invite_only');
    await addMember(groupId, ada);
    await addMember(groupId, ben);

    await pool.query(
      `INSERT INTO group_join_requests (group_id, user_id, status, resolved_at, resolved_by)
       VALUES ($1, $2, 'approved', now(), $3)`,
      [groupId, ben, ada],
    );

    const res = await deleteAccount(ada);
    expect(res.statusCode).toBe(200);

    const stillThere = await pool.query('SELECT 1 FROM users WHERE id = $1', [ada]);
    expect(stillThere.rowCount).toBe(0);

    // The request itself survives for the group (Ben's own row), it just loses
    // the attribution to the deleted admin — same shape as group_events.created_by.
    const reqRow = await pool.query<{ status: string; resolved_by: string | null }>(
      'SELECT status, resolved_by FROM group_join_requests WHERE group_id = $1',
      [groupId],
    );
    expect(reqRow.rows[0].status).toBe('approved');
    expect(reqRow.rows[0].resolved_by).toBeNull();
  });

  it('deletes the account of an admin who has rejected a join request', async () => {
    const cara = await createUser('Cara');
    const dev = await createUser('Dev');
    const groupId = await createGroup(cara, 'BBB222', 'invite_only');
    await addMember(groupId, cara);
    await addMember(groupId, dev);

    await pool.query(
      `INSERT INTO group_join_requests (group_id, user_id, status, resolved_at, resolved_by)
       VALUES ($1, $2, 'rejected', now(), $3)`,
      [groupId, dev, cara],
    );

    const res = await deleteAccount(cara);
    expect(res.statusCode).toBe(200);
    expect((await pool.query('SELECT 1 FROM users WHERE id = $1', [cara])).rowCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Full fan-out: one row in (nearly) every table that references users(id).
  // -------------------------------------------------------------------------
  it('deletes an account that has a row in every user-referencing table', async () => {
    const eve = await createUser('Eve');
    const fay = await createUser('Fay');
    const groupId = await createGroup(eve, 'CCC333');
    await addMember(groupId, eve);
    await addMember(groupId, fay);

    await pool.query(
      `INSERT INTO auth_providers (user_id, provider, provider_id) VALUES ($1, 'email', 'eve@example.com')`,
      [eve],
    );
    await pool.query(`INSERT INTO devices (user_id, push_token, platform) VALUES ($1, 'tok-eve', 'ios')`, [eve]);
    await pool.query(`INSERT INTO vehicles (user_id, make, model) VALUES ($1, 'Mazda', 'MX-5')`, [eve]);
    await pool.query(
      `INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'accepted')`,
      [eve, fay],
    );
    await pool.query(`INSERT INTO user_settings (user_id) VALUES ($1)`, [eve]);
    await pool.query(
      `INSERT INTO user_recent_places (user_id, name, lat, lng) VALUES ($1, 'Cafe', 51.5, -0.12)`,
      [eve],
    );
    const eventRes = await pool.query<{ id: string }>(
      `INSERT INTO group_events (group_id, created_by, title, scheduled_for)
       VALUES ($1, $2, 'Sunday run', now()) RETURNING id`,
      [groupId, eve],
    );
    await pool.query(`INSERT INTO event_rsvps (event_id, user_id, status) VALUES ($1, $2, 'going')`, [
      eventRes.rows[0].id,
      eve,
    ]);
    await pool.query(`INSERT INTO notification_history (user_id, type, title, body) VALUES ($1, 'gap_alert', 't', 'b')`, [eve]);
    // analytics_events grew a NOT NULL event_id in a later migration — supply
    // it only when the column is there, so this seed survives schema growth.
    const hasEventId = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'analytics_events' AND column_name = 'event_id'`,
    );
    await pool.query(
      (hasEventId.rowCount ?? 0) > 0
        ? `INSERT INTO analytics_events (anonymous_id, user_id, platform, event_name, event_id)
           VALUES ('anon-eve', $1, 'ios', 'app_open', 'evt-eve')`
        : `INSERT INTO analytics_events (anonymous_id, user_id, platform, event_name)
           VALUES ('anon-eve', $1, 'ios', 'app_open')`,
      [eve],
    );
    await pool.query(`INSERT INTO group_photos (group_id, user_id, photo_url) VALUES ($1, $2, 'https://x/p.jpg')`, [groupId, eve]);
    const msgRes = await pool.query<{ id: string }>(
      `INSERT INTO group_messages (group_id, user_id, text, type) VALUES ($1, $2, 'hi', 'text') RETURNING id`,
      [groupId, eve],
    );
    await pool.query(`INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, '🔥')`, [
      msgRes.rows[0].id,
      eve,
    ]);
    await pool.query(
      `INSERT INTO fuel_logs (user_id, date, gallons, price_per_gallon) VALUES ($1, now(), 10, 4.5)`,
      [eve],
    );
    await pool.query(`INSERT INTO user_stat_counters (user_id, stat_key, count) VALUES ($1, 'sos_hero', 2)`, [eve]);
    await pool.query(
      `INSERT INTO nearby_presence (user_id, approx_location)
       VALUES ($1, ST_SetSRID(ST_MakePoint(-0.12, 51.5), 4326)::geography)`,
      [eve],
    );
    await pool.query(
      `INSERT INTO drive_history (group_id, user_id, route_trace, distance_m, duration_s, started_at, ended_at)
       VALUES ($1, $2, '{"type":"LineString","coordinates":[[0,0],[1,1]]}', 100, 60, now(), now())`,
      [groupId, eve],
    );
    const hazardRes = await pool.query<{ id: string }>(
      `INSERT INTO hazard_reports (reporter_id, hazard_type, location, expires_at)
       VALUES ($1, 'police', ST_SetSRID(ST_MakePoint(-0.12, 51.5), 4326)::geography, now() + interval '1 hour')
       RETURNING id`,
      [eve],
    );
    await pool.query(`INSERT INTO hazard_votes (hazard_id, user_id, vote) VALUES ($1, $2, 'confirm')`, [
      hazardRes.rows[0].id,
      eve,
    ]);
    const cameraRes = await pool.query<{ id: string }>(
      `INSERT INTO speed_cameras (lat, lng, type, reporter_id) VALUES (51.5, -0.12, 'fixed', $1) RETURNING id`,
      [eve],
    );
    await pool.query(`INSERT INTO speed_camera_votes (camera_id, user_id, vote) VALUES ($1, $2, 'confirm')`, [
      cameraRes.rows[0].id,
      eve,
    ]);
    await pool.query(
      `INSERT INTO rally_points (group_id, broadcaster_id, location)
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint(-0.12, 51.5), 4326)::geography)`,
      [groupId, eve],
    );
    const channelRes = await pool.query<{ id: string }>(
      `INSERT INTO ptt_channels (group_id, name, is_all) VALUES ($1, 'All', true) RETURNING id`,
      [groupId],
    );
    await pool.query(`INSERT INTO ptt_channel_members (channel_id, user_id) VALUES ($1, $2)`, [
      channelRes.rows[0].id,
      eve,
    ]);
    await pool.query(`INSERT INTO ptt_log (group_id, user_id, channel_id) VALUES ($1, $2, $3)`, [
      groupId,
      eve,
      channelRes.rows[0].id,
    ]);
    await pool.query(
      `INSERT INTO group_join_requests (group_id, user_id, status, resolved_at, resolved_by)
       VALUES ($1, $2, 'approved', now(), $3)`,
      [groupId, fay, eve],
    );
    await pool.query(`UPDATE convoy_groups SET leader_id = $1 WHERE id = $2`, [eve, groupId]);

    const res = await deleteAccount(eve);
    expect(res.statusCode).toBe(200);

    expect((await pool.query('SELECT 1 FROM users WHERE id = $1', [eve])).rowCount).toBe(0);

    // The group survives for Fay, with admin transferred to her.
    const group = await pool.query<{ admin_id: string; leader_id: string | null }>(
      'SELECT admin_id, leader_id FROM convoy_groups WHERE id = $1',
      [groupId],
    );
    expect(group.rows[0].admin_id).toBe(fay);
    expect(group.rows[0].leader_id).toBeNull();

    // Nothing anywhere still points at the deleted user.
    const analytics = await pool.query<{ user_id: string | null }>(
      `SELECT user_id FROM analytics_events WHERE anonymous_id = 'anon-eve'`,
    );
    expect(analytics.rows[0].user_id).toBeNull();
    for (const [table, column] of [
      ['convoy_members', 'user_id'],
      ['group_messages', 'user_id'],
      ['group_photos', 'user_id'],
      ['drive_history', 'user_id'],
      ['hazard_reports', 'reporter_id'],
      ['hazard_votes', 'user_id'],
      ['rally_points', 'broadcaster_id'],
      ['ptt_log', 'user_id'],
      ['ptt_channel_members', 'user_id'],
      ['vehicles', 'user_id'],
      ['devices', 'user_id'],
      ['auth_providers', 'user_id'],
      ['user_settings', 'user_id'],
      ['user_recent_places', 'user_id'],
      ['user_stat_counters', 'user_id'],
      ['nearby_presence', 'user_id'],
      ['notification_history', 'user_id'],
      ['friendships', 'requester_id'],
      ['fuel_logs', 'user_id'],
      ['event_rsvps', 'user_id'],
      ['speed_camera_votes', 'user_id'],
    ] as const) {
      const left = await pool.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [eve]);
      expect({ table, rows: left.rowCount }).toEqual({ table, rows: 0 });
    }
  });

  // -------------------------------------------------------------------------
  // The rest of the convoy has to be told, and the deleted account's own
  // sockets have to stop transmitting.
  // -------------------------------------------------------------------------
  describe('live convoy cleanup', () => {
    it('emits member:left to every convoy the deleted member was still in', async () => {
      // Hal and Ivy are mid-drive together. Hal opens Settings → Delete Account.
      // Ivy's ConvoyScreen roster and map are driven by the member:left socket
      // event; before this fix account deletion emitted nothing at all, so Hal's
      // member card and map pin — name, avatar, callsign — stayed on Ivy's
      // screen until she navigated away and refetched.
      const hal = await createUser('Hal');
      const ivy = await createUser('Ivy');
      const groupId = await createGroup(hal, 'DDD444');
      await addMember(groupId, hal);
      await addMember(groupId, ivy);

      expect((await deleteAccount(hal)).statusCode).toBe(200);

      expect(emissions).toContainEqual({
        room: `group:${groupId}`,
        event: 'member:left',
        data: { userId: hal },
      });
    });

    it('sends group:ended (not member:left) for a convoy that had no other members', async () => {
      const jax = await createUser('Jax');
      const groupId = await createGroup(jax, 'EEE555');
      await addMember(groupId, jax);

      expect((await deleteAccount(jax)).statusCode).toBe(200);

      expect(emissions.map((e) => e.event)).toContain('group:ended');
      expect(emissions.some((e) => e.event === 'member:left')).toBe(false);
    });

    it('force-disconnects the deleted account\'s own sockets', async () => {
      // socket.handler resolves the socket's groupId once at connect time and
      // never re-checks it, so an app that hasn't yet noticed the deletion kept
      // streaming GPS into the convoy room. POST /groups/:id/leave already cuts
      // the socket for exactly this reason; deletion must too.
      const kit = await createUser('Kit');
      const lena = await createUser('Lena');
      const groupId = await createGroup(kit, 'FFF666');
      await addMember(groupId, kit);
      await addMember(groupId, lena);

      expect((await deleteAccount(kit)).statusCode).toBe(200);
      expect(disconnectedRooms).toContain(`user:${kit}`);
    });
  });

  // -------------------------------------------------------------------------
  // Uploaded files (Req 36.3 "hard-delete").
  // -------------------------------------------------------------------------
  describe('uploaded files', () => {
    function writeUpload(filename: string): string {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), 'bytes');
      return `https://api.convoy.app/api/v1/uploads/${filename}`;
    }

    it('removes the account\'s avatar, vehicle photos, group photos and voice notes', async () => {
      // Every one of these URLs is public, immutable and cache-forever. Before
      // this fix the DB rows cascaded away but the files did not, so a deleted
      // user's profile photo stayed downloadable by anyone who had ever saved
      // the link — from a group gallery, a shared drive card, anywhere.
      const mia = await createUser('Mia');
      const ned = await createUser('Ned');
      const groupId = await createGroup(mia, 'GGG777');
      await addMember(groupId, mia);
      await addMember(groupId, ned);

      const avatar = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg';
      const carPhoto = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png';
      const groupPhoto = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc.jpg';
      const voiceNote = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd.m4a';
      const keeperPhoto = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jpg';

      await pool.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [writeUpload(avatar), mia]);
      await pool.query(`INSERT INTO vehicles (user_id, make, photo_url) VALUES ($1, 'Honda', $2)`, [
        mia,
        writeUpload(carPhoto),
      ]);
      await pool.query(`INSERT INTO group_photos (group_id, user_id, photo_url) VALUES ($1, $2, $3)`, [
        groupId,
        mia,
        writeUpload(groupPhoto),
      ]);
      await pool.query(
        `INSERT INTO group_messages (group_id, user_id, type, audio_url) VALUES ($1, $2, 'voice', $3)`,
        [groupId, mia, writeUpload(voiceNote)],
      );
      // Ned's photo in the same group must survive untouched.
      await pool.query(`INSERT INTO group_photos (group_id, user_id, photo_url) VALUES ($1, $2, $3)`, [
        groupId,
        ned,
        writeUpload(keeperPhoto),
      ]);

      expect((await deleteAccount(mia)).statusCode).toBe(200);

      for (const gone of [avatar, carPhoto, groupPhoto, voiceNote]) {
        expect({ file: gone, exists: fs.existsSync(path.join(UPLOADS_DIR, gone)) })
          .toEqual({ file: gone, exists: false });
      }
      expect(fs.existsSync(path.join(UPLOADS_DIR, keeperPhoto))).toBe(true);
    });

    it('leaves externally hosted URLs alone', async () => {
      // An avatar that isn't ours must never be turned into a path we delete.
      const oli = await createUser('Oli');
      await pool.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [
        'https://lh3.googleusercontent.com/a/photo.jpg',
        oli,
      ]);
      expect((await deleteAccount(oli)).statusCode).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Deletion must free the identity for a fresh signup.
  // -------------------------------------------------------------------------
  it('frees the email, phone and auth-provider identity for a fresh signup', async () => {
    const gus = await pool.query<{ id: string }>(
      `INSERT INTO users (display_name, email, phone_number)
       VALUES ('Gus', 'gus@example.com', '+15550001111') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO auth_providers (user_id, provider, provider_id) VALUES ($1, 'email', 'gus@example.com')`,
      [gus.rows[0].id],
    );

    expect((await deleteAccount(gus.rows[0].id)).statusCode).toBe(200);

    const reborn = await pool.query<{ id: string }>(
      `INSERT INTO users (display_name, email, phone_number)
       VALUES ('Gus Again', 'gus@example.com', '+15550001111') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO auth_providers (user_id, provider, provider_id) VALUES ($1, 'email', 'gus@example.com')`,
      [reborn.rows[0].id],
    );
    expect(reborn.rows[0].id).not.toBe(gus.rows[0].id);
    // The new account inherits nothing from the old one.
    expect(
      (await pool.query('SELECT 1 FROM friendships WHERE requester_id = $1 OR addressee_id = $1', [reborn.rows[0].id]))
        .rowCount,
    ).toBe(0);
  });
});
