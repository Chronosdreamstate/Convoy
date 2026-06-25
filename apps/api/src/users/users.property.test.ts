/**
 * Property tests for the users API.
 *
 * Property 55: PATCH /users/me enforces field constraints
 *   Validates: Requirements 3.1, 3.3, 3.4
 *
 * Property 56: PATCH /users/me updates only specified fields
 *   Validates: Requirements 3.1, 3.4
 *
 * Property 57: Phone search respects invite_only privacy
 *   Validates: Requirements 3.4
 *
 * Property 58: Display-name search only returns open-privacy users
 *   Validates: Requirements 3.4
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import fc from 'fast-check';
import { Pool } from 'pg';
import Redis from 'ioredis';
import usersRoutes from './users.routes';

// ---------------------------------------------------------------------------
// In-memory user store
// ---------------------------------------------------------------------------
interface InMemoryUser {
  id: string;
  display_name: string;
  phone_number: string | null;
  email: string | null;
  avatar_url: string | null;
  ptt_callsign: string | null;
  privacy: 'open' | 'invite_only';
  created_at: Date;
}

interface InMemoryFriendship {
  requester_id: string;
  addressee_id: string;
  status: 'accepted';
}

let usersDb: Map<string, InMemoryUser>;
let friendships: InMemoryFriendship[];
let devices: Array<{ user_id: string; push_token: string; platform: string }>;

function resetStore(initial: InMemoryUser[] = []) {
  usersDb = new Map(initial.map((u) => [u.id, u]));
  friendships = [];
  devices = [];
}

function buildMockPool(): Pool {
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      const norm = sql.replace(/\s+/g, ' ').trim().toUpperCase();

      // PATCH /users/me — UPDATE users SET ... WHERE id = $N RETURNING ...
      if (norm.includes('UPDATE USERS SET') && norm.includes('RETURNING')) {
        const vals = params as unknown[];
        const userId = vals[vals.length - 1] as string;
        const u = usersDb.get(userId);
        if (!u) return { rows: [], rowCount: 0 };

        const updated = { ...u };

        // Parse SET clause to extract column -> value mappings
        const setSection = sql.match(/SET (.+?) WHERE/s)?.[1] ?? '';
        const pairs = setSection.split(',').map((s) => s.trim()).filter((s) => !s.startsWith('updated_at'));
        let idx = 0;
        for (const pair of pairs) {
          const col = pair.split('=')[0].trim().toLowerCase();
          const val = vals[idx++] as string | null;
          if (col === 'display_name') updated.display_name = val as string;
          else if (col === 'avatar_url') updated.avatar_url = val;
          else if (col === 'ptt_callsign') updated.ptt_callsign = val;
          else if (col === 'privacy') updated.privacy = val as 'open' | 'invite_only';
        }

        usersDb.set(userId, updated);
        return { rows: [updated], rowCount: 1 };
      }

      // GET /users/search?phone= — phone lookup (must be before generic SELECT checks)
      if (norm.includes('PHONE_NUMBER = $1 LIMIT 1')) {
        const phone = params![0] as string;
        const found = [...usersDb.values()].find((u) => u.phone_number === phone);
        if (!found) return { rows: [], rowCount: 0 };
        return { rows: [found], rowCount: 1 };
      }

      // GET /users/search?q= — display name search
      if (norm.includes('DISPLAY_NAME ILIKE')) {
        const callerId = params![0] as string;
        const pattern = (params![1] as string).replace(/%/g, '').toLowerCase();
        const matches = [...usersDb.values()].filter(
          (u) => u.id !== callerId && u.privacy === 'open' && u.display_name.toLowerCase().includes(pattern),
        );
        return { rows: matches, rowCount: matches.length };
      }

      // Friendship check for phone search privacy
      if (norm.includes("STATUS = 'ACCEPTED'") && norm.includes('FRIENDSHIPS')) {
        const [a, b] = params as [string, string];
        const found = friendships.find(
          (f) =>
            (f.requester_id === a && f.addressee_id === b) ||
            (f.requester_id === b && f.addressee_id === a),
        );
        return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
      }

      // GET /users/me — full profile with created_at
      if (norm.includes('CREATED_AT') && norm.includes('FROM USERS WHERE ID = $1')) {
        const userId = params![0] as string;
        const u = usersDb.get(userId);
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }

      // PATCH /users/me (no-op path) — partial SELECT without created_at
      if (norm.includes('FROM USERS WHERE ID = $1')) {
        const userId = params![0] as string;
        const u = usersDb.get(userId);
        return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
      }

      // GET /users/:id — public profile by UUID (not phone)
      if (norm.includes('SELECT ID, DISPLAY_NAME, AVATAR_URL, PTT_CALLSIGN') && norm.includes('FROM USERS WHERE ID = $1')) {
        const userId = params![0] as string;
        const u = usersDb.get(userId);
        if (!u) return { rows: [], rowCount: 0 };
        return { rows: [{ id: u.id, display_name: u.display_name, avatar_url: u.avatar_url, ptt_callsign: u.ptt_callsign }], rowCount: 1 };
      }

      // POST /devices — upsert device
      if (norm.includes('DEVICES')) {
        const [userId, pushToken, platform] = params as [string, string, string];
        const existing = devices.findIndex((d) => d.push_token === pushToken);
        if (existing >= 0) {
          devices[existing].user_id = userId;
        } else {
          devices.push({ user_id: userId, push_token: pushToken, platform });
        }
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
  } as unknown as Pool;
  return pool;
}

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);
  app.register(fastifyJwt, {
    secret: 'test-secret-that-is-at-least-32-chars-long!!',
    sign: { expiresIn: '15m' },
  });
  app.register(fastifySensible);
  app.register(fp(async (inst) => { inst.decorate('db', buildMockPool()); }, { name: 'db' }));
  app.register(fp(async (inst) => { inst.decorate('redis', {} as Redis); }, { name: 'redis' }));
  app.register(usersRoutes, { prefix: '/api/v1' });
  return app;
}

async function makeToken(app: FastifyInstance, userId: string): Promise<string> {
  await app.ready();
  return app.jwt.sign({ sub: userId });
}

function makeUser(id: string, overrides: Partial<InMemoryUser> = {}): InMemoryUser {
  return {
    id,
    display_name: `User ${id}`,
    phone_number: null,
    email: null,
    avatar_url: null,
    ptt_callsign: null,
    privacy: 'open',
    created_at: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Property 55: PATCH /users/me enforces field constraints
// ---------------------------------------------------------------------------
describe('Property 55: PATCH /users/me enforces field constraints', () => {
  it('empty displayName (zero-length) is rejected with 400', async () => {
    const app = buildTestApp();
    resetStore([makeUser('u1')]);
    const token = await makeToken(app, 'u1');

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: { Authorization: `Bearer ${token}` },
      payload: { displayName: '' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('displayName over 100 chars is rejected with 400', async () => {
    const app = buildTestApp();
    resetStore([makeUser('u1')]);
    const token = await makeToken(app, 'u1');

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 101, maxLength: 200 }),
        async (longName) => {
          const res = await app.inject({
            method: 'PATCH',
            url: '/api/v1/users/me',
            headers: { Authorization: `Bearer ${token}` },
            payload: { displayName: longName },
          });
          expect(res.statusCode).toBe(400);
        },
      ),
      { numRuns: 20 },
    );
    await app.close();
  });

  it('privacy must be open or invite_only — other values rejected', async () => {
    const app = buildTestApp();
    resetStore([makeUser('u1')]);
    const token = await makeToken(app, 'u1');

    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((s) => !['open', 'invite_only'].includes(s) && s.length > 0),
        async (badPrivacy) => {
          const res = await app.inject({
            method: 'PATCH',
            url: '/api/v1/users/me',
            headers: { Authorization: `Bearer ${token}` },
            payload: { privacy: badPrivacy },
          });
          expect(res.statusCode).toBe(400);
        },
      ),
      { numRuns: 20 },
    );
    await app.close();
  });

  it('avatarUrl must be a valid URL or null — random strings rejected', async () => {
    const app = buildTestApp();
    resetStore([makeUser('u1')]);
    const token = await makeToken(app, 'u1');

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }).filter((s) => {
          try { new URL(s); return false; } catch { return true; }
        }),
        async (badUrl) => {
          const res = await app.inject({
            method: 'PATCH',
            url: '/api/v1/users/me',
            headers: { Authorization: `Bearer ${token}` },
            payload: { avatarUrl: badUrl },
          });
          expect(res.statusCode).toBe(400);
        },
      ),
      { numRuns: 20 },
    );
    await app.close();
  });

  it('valid displayName (1–100 chars) is accepted', async () => {
    const app = buildTestApp();
    resetStore([makeUser('u1')]);
    const token = await makeToken(app, 'u1');

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 100 }),
        async (name) => {
          const res = await app.inject({
            method: 'PATCH',
            url: '/api/v1/users/me',
            headers: { Authorization: `Bearer ${token}` },
            payload: { displayName: name },
          });
          expect(res.statusCode).toBe(200);
          const body = JSON.parse(res.body) as { displayName: string };
          expect(body.displayName).toBe(name);
        },
      ),
      { numRuns: 20 },
    );
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property 56: PATCH /users/me updates only specified fields
// ---------------------------------------------------------------------------
describe('Property 56: PATCH /users/me updates only specified fields', () => {
  it('updating privacy does not change displayName', async () => {
    const initialName = 'Convoy Rider';
    const app = buildTestApp();
    resetStore([makeUser('u1', { display_name: initialName })]);
    const token = await makeToken(app, 'u1');

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: { Authorization: `Bearer ${token}` },
      payload: { privacy: 'invite_only' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { displayName: string; privacy: string };
    expect(body.displayName).toBe(initialName);
    expect(body.privacy).toBe('invite_only');

    await app.close();
  });

  it('setting pttCallsign to null clears it', async () => {
    const app = buildTestApp();
    resetStore([makeUser('u1', { ptt_callsign: 'ALPHA-1' })]);
    const token = await makeToken(app, 'u1');

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: { Authorization: `Bearer ${token}` },
      payload: { pttCallsign: null },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { pttCallsign: string | null };
    expect(body.pttCallsign).toBeNull();

    await app.close();
  });

  it('empty PATCH returns current profile unchanged', async () => {
    const app = buildTestApp();
    const u = makeUser('u1', { display_name: 'Road Warrior', privacy: 'invite_only' });
    resetStore([u]);
    const token = await makeToken(app, 'u1');

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me',
      headers: { Authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { displayName: string; privacy: string };
    expect(body.displayName).toBe('Road Warrior');
    expect(body.privacy).toBe('invite_only');

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property 57: Phone search respects invite_only privacy
// ---------------------------------------------------------------------------
describe('Property 57: Phone search respects invite_only privacy', () => {
  it('invite_only user is hidden from non-friends', async () => {
    const privateUser = makeUser('u-private', { phone_number: '+15555550001', privacy: 'invite_only' });
    const searcher = makeUser('u-searcher');
    const app = buildTestApp();
    resetStore([privateUser, searcher]);
    const token = await makeToken(app, searcher.id);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/users/search?phone=${encodeURIComponent(privateUser.phone_number!)}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { user: unknown };
    expect(body.user).toBeNull();

    await app.close();
  });

  it('invite_only user is visible to an accepted friend', async () => {
    const privateUser = makeUser('u-private', { phone_number: '+15555550002', privacy: 'invite_only' });
    const searcher = makeUser('u-friend');
    const app = buildTestApp();
    resetStore([privateUser, searcher]);
    friendships.push({ requester_id: searcher.id, addressee_id: privateUser.id, status: 'accepted' });
    const token = await makeToken(app, searcher.id);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/users/search?phone=${encodeURIComponent(privateUser.phone_number!)}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { user: { id: string } };
    expect(body.user).not.toBeNull();
    expect(body.user?.id).toBe(privateUser.id);

    await app.close();
  });

  it('open-privacy user is always visible by phone search', async () => {
    const openUser = makeUser('u-open', { phone_number: '+15555550003', privacy: 'open' });
    const searcher = makeUser('u-any');
    const app = buildTestApp();
    resetStore([openUser, searcher]);
    const token = await makeToken(app, searcher.id);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/users/search?phone=${encodeURIComponent(openUser.phone_number!)}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { user: { id: string } };
    expect(body.user?.id).toBe(openUser.id);

    await app.close();
  });

  it('missing phone and q parameters returns 400', async () => {
    const app = buildTestApp();
    resetStore([makeUser('u1')]);
    const token = await makeToken(app, 'u1');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/search',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property 58: Display-name search only returns open-privacy users
// ---------------------------------------------------------------------------
describe('Property 58: Display-name search only returns open-privacy users', () => {
  it('invite_only users never appear in name search results', async () => {
    const publicUsers = [
      makeUser('u-pub-1', { display_name: 'Alice Open', privacy: 'open' }),
      makeUser('u-pub-2', { display_name: 'Alice Public', privacy: 'open' }),
    ];
    const privateUser = makeUser('u-priv', { display_name: 'Alice Private', privacy: 'invite_only' });
    const searcher = makeUser('u-searcher');
    const app = buildTestApp();
    resetStore([...publicUsers, privateUser, searcher]);
    const token = await makeToken(app, searcher.id);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/search?q=Alice',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { users: Array<{ id: string }> };
    const ids = body.users.map((u) => u.id);
    expect(ids).not.toContain(privateUser.id);
    expect(ids).toContain('u-pub-1');
    expect(ids).toContain('u-pub-2');

    await app.close();
  });

  it('search query shorter than 2 characters is rejected', async () => {
    const app = buildTestApp();
    resetStore([makeUser('u1')]);
    const token = await makeToken(app, 'u1');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/search?q=A',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('unauthenticated search returns 401', async () => {
    const app = buildTestApp();
    resetStore();
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v1/users/search?q=test' });
    expect(res.statusCode).toBe(401);

    await app.close();
  });
});
