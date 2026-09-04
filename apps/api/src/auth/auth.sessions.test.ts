/**
 * Sessions: what a refresh token identifies, and what signing out ends.
 *
 * The refresh store used to be one Redis string per USER, so it could only
 * remember one live token at a time. Every one of these tests fails against
 * that shape:
 *  - a second device signing in evicted the first, which was then thrown out
 *    at its next refresh (i.e. you could not stay signed in on a phone and a
 *    tablet at the same time);
 *  - tapping Sign Out on one device deleted the key and signed out every
 *    other device too.
 * Reuse of an already-rotated token must still revoke everything — that is the
 * standard response to a stolen refresh token and the one behaviour of the old
 * shape worth keeping.
 *
 * Also covers the login timing oracle: the compare against a dummy hash for an
 * unknown email only hides which accounts exist if that hash is a REAL bcrypt
 * hash. bcryptjs rejects a malformed one immediately, which is what the
 * previous hard-coded literal was.
 */

// jose is ESM-only; stub it so ts-jest (CommonJS) can import auth.routes.ts.
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
}));

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import Redis from 'ioredis';
import authRoutes from './auth.routes';

const TEST_USER = {
  id: 'user-sessions-1',
  display_name: 'Rider',
  phone_number: '+15555550142',
  email: null as string | null,
};

const PHONE = '+15555550142';

/** Test app: phone-OTP sign-in (two of them = two devices) plus refresh. */
function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(fastifyCookie);
  app.register(fastifyJwt, {
    secret: 'test-secret-that-is-at-least-32-chars-long!!',
    sign: { expiresIn: '15m' },
  });
  app.register(fastifySensible);

  app.register(
    fp(async (instance) => {
      const query = async (sql: string) => {
        if (sql.includes('INSERT INTO users')) return { rows: [TEST_USER] };
        // POST /auth/refresh checks the user still exists.
        if (sql.includes('SELECT id FROM users WHERE id')) return { rows: [{ id: TEST_USER.id }] };
        if (sql.includes('JOIN auth_providers')) return { rows: [] }; // unknown email
        return { rows: [] };
      };
      const pool = {
        query,
        connect: async () => ({ query, release: () => {} }),
      } as unknown as Pool;
      instance.decorate('db', pool);
    }),
    { name: 'db' },
  );

  app.register(
    fp(async (instance) => {
      const store = new Map<string, string>();
      const sets = new Map<string, Set<string>>();

      const redis = {
        get: async (k: string) => store.get(k) ?? null,
        set: async (k: string, v: string) => {
          store.set(k, v);
        },
        setex: async (k: string, _ttl: number, v: string) => {
          store.set(k, v);
        },
        getdel: async (k: string) => {
          const v = store.get(k) ?? null;
          store.delete(k);
          return v;
        },
        del: async (k: string) => {
          store.delete(k);
          sets.delete(k);
        },
        incr: async (k: string) => {
          const next = parseInt(store.get(k) ?? '0', 10) + 1;
          store.set(k, String(next));
          return next;
        },
        expire: async () => {},
        sadd: async (k: string, m: string) => {
          const set = sets.get(k) ?? new Set<string>();
          const had = set.has(m);
          set.add(m);
          sets.set(k, set);
          return had ? 0 : 1;
        },
        srem: async (k: string, m: string) => {
          const set = sets.get(k);
          if (!set || !set.has(m)) return 0;
          set.delete(m);
          return 1;
        },
        smembers: async (k: string) => [...(sets.get(k) ?? [])],
        exists: async (k: string) => (store.has(k) ? 1 : 0),
        ping: async () => 'PONG',
        quit: async () => {},
      } as unknown as Redis;

      instance.decorate('redis', redis);
    }),
    { name: 'redis' },
  );

  app.register(authRoutes, { prefix: '/api/v1' });
  return app;
}

/** Reads the refreshToken cookie out of a set-cookie header. */
function refreshCookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const all = Array.isArray(raw) ? raw : [raw];
  const cookie = all.map(String).find((c) => c.startsWith('refreshToken='));
  if (!cookie) throw new Error('no refreshToken cookie in response');
  return cookie.split(';')[0].slice('refreshToken='.length);
}

/** Signs in over the phone-OTP flow and returns that device's refresh token. */
async function signInDevice(app: FastifyInstance): Promise<string> {
  const requested = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/request',
    payload: { phone: PHONE },
  });
  const { _dev_otp: otp } = JSON.parse(requested.body) as { _dev_otp: string };

  const verified = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/verify',
    payload: { phone: PHONE, otp },
  });
  expect(verified.statusCode).toBe(200);
  return refreshCookieOf(verified);
}

function refresh(app: FastifyInstance, token: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    cookies: { refreshToken: token },
  });
}

let app: FastifyInstance;

beforeEach(async () => {
  app = buildTestApp();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('POST /auth/refresh — one live token per device', () => {
  it('keeps the first device signed in after a second device signs in', async () => {
    const phoneToken = await signInDevice(app);
    const tabletToken = await signInDevice(app);
    expect(phoneToken).not.toBe(tabletToken);

    // The phone has not touched the app since; its token must still work.
    const phoneRefresh = await refresh(app, phoneToken);
    expect(phoneRefresh.statusCode).toBe(200);

    // And the tablet's own token is unaffected by the phone rotating.
    const tabletRefresh = await refresh(app, tabletToken);
    expect(tabletRefresh.statusCode).toBe(200);
  });

  it('rotates each device independently', async () => {
    const phoneToken = await signInDevice(app);
    const tabletToken = await signInDevice(app);

    const rotated = await refresh(app, phoneToken);
    const phoneToken2 = refreshCookieOf(rotated);

    // The phone's new token works, its old one does not, and the tablet is
    // untouched by either.
    expect((await refresh(app, phoneToken2)).statusCode).toBe(200);
    expect((await refresh(app, tabletToken)).statusCode).toBe(200);
  });

  it('treats a replayed token as reuse and revokes every session', async () => {
    const phoneToken = await signInDevice(app);
    const tabletToken = await signInDevice(app);

    // Rotate the phone once, then present the consumed token again.
    await refresh(app, phoneToken);
    const replay = await refresh(app, phoneToken);
    expect(replay.statusCode).toBe(401);

    // A stolen token means every session for that user is suspect.
    expect((await refresh(app, tabletToken)).statusCode).toBe(401);
  });
});

describe('POST /auth/logout — ends this device only', () => {
  it('leaves the user signed in on their other device', async () => {
    const phoneToken = await signInDevice(app);
    const tabletToken = await signInDevice(app);

    const loggedOut = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { refreshToken: phoneToken },
    });
    expect(loggedOut.statusCode).toBe(200);

    // The phone is out...
    expect((await refresh(app, phoneToken)).statusCode).toBe(401);
    // ...but signing out here must not sign the tablet out as a side effect.
    expect((await refresh(app, tabletToken)).statusCode).toBe(200);
  });
});

describe('POST /auth/email/login — unknown email costs the same as a real one', () => {
  it('compares against a well-formed bcrypt hash when no account exists', async () => {
    const compare = jest.spyOn(bcrypt, 'compare');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/login',
      payload: { email: 'nobody@example.com', password: 'password123' },
    });

    expect(res.statusCode).toBe(401);
    expect(compare).toHaveBeenCalledTimes(1);

    // bcryptjs returns false immediately for a malformed hash, so the dummy
    // must be a real one or the response time reveals that the account does
    // not exist. 60 chars: $2<x>$<cost>$<22 salt><31 digest>.
    const hashCompared = compare.mock.calls[0][1] as string;
    expect(hashCompared).toMatch(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/);
    expect(bcrypt.getRounds(hashCompared)).toBe(10);

    compare.mockRestore();
  });
});
