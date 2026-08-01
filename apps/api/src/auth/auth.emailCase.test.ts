/**
 * Email is a case-insensitive account identity.
 *
 * Before this, users.email was stored as typed under a case-SENSITIVE UNIQUE
 * constraint, so `Foo@Example.com` and `foo@example.com` were two accounts:
 * a second signup with different capitalisation quietly forked the user, and
 * signing in with different capitalisation than you registered with was
 * indistinguishable from a wrong password.
 *
 * These tests pin the behaviour at the two places it has to hold — the request
 * schemas (which fold before anything else runs) and the routes' actual DB
 * lookups — plus the normalizer itself.
 */

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn().mockResolvedValue({ payload: { sub: 'social-sub', email: 'Mixed.Case@Example.COM' } }),
}));

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import authRoutes from './auth.routes';
import { normalizeEmail } from './email';
import { emailSignupSchema, emailLoginSchema } from './auth.schemas';

// ---------------------------------------------------------------------------
// Harness — records every parameter the routes send to the DB.
// ---------------------------------------------------------------------------

let queries: Array<{ sql: string; params: unknown[] }>;

function record(sql: string, params: unknown[] = []) {
  queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
}

/** Params of the first query whose SQL contains `fragment`. */
function paramsFor(fragment: string): unknown[] | undefined {
  return queries.find((q) => q.sql.includes(fragment))?.params;
}

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);
  app.register(fastifyJwt, { secret: 'test-secret-that-is-at-least-32-chars-long!!', sign: { expiresIn: '15m' } });
  app.register(fastifySensible);

  app.register(fp(async (i) => {
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        record(sql, params);
        return { rows: [], rowCount: 0 };
      },
      connect: async () => ({
        query: async (sql: string, params?: unknown[]) => {
          record(sql, params);
          // upsertUserByEmail/BySocial read rows[0] straight back
          if (sql.includes('INSERT INTO users')) {
            return { rows: [{ id: 'user-1', display_name: 'x', phone_number: null, email: params?.[1] ?? null }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release: () => {},
      }),
    } as unknown as Pool;
    i.decorate('db', pool);
  }, { name: 'db' }));

  app.register(fp(async (i) => {
    const store = new Map<string, string>();
    const redis = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => { store.set(k, v); },
      del: async (k: string) => { store.delete(k); },
      incr: async (k: string) => {
        const next = parseInt(store.get(k) ?? '0', 10) + 1;
        store.set(k, String(next));
        return next;
      },
      expire: async () => {},
    } as unknown as Redis;
    i.decorate('redis', redis);
  }, { name: 'redis' }));

  app.register(authRoutes, { prefix: '/api/v1' });
  return app;
}

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
afterAll(async () => { await app.close(); });
beforeEach(() => { queries = []; });

// ---------------------------------------------------------------------------

describe('normalizeEmail', () => {
  it('folds case and trims surrounding whitespace', () => {
    expect(normalizeEmail('  Foo@Example.COM ')).toBe('foo@example.com');
  });

  it('is idempotent', () => {
    const once = normalizeEmail('Foo@Example.com');
    expect(normalizeEmail(once)).toBe(once);
  });

  it('leaves an already-canonical address untouched', () => {
    expect(normalizeEmail('foo@example.com')).toBe('foo@example.com');
  });

  it('does not apply provider-specific folding (dots and +tags are significant)', () => {
    // Stripping these would merge addresses their owners treat as distinct.
    expect(normalizeEmail('First.Last+convoy@Gmail.com')).toBe('first.last+convoy@gmail.com');
  });
});

describe('auth request schemas', () => {
  it('signup folds the email before anything downstream sees it', () => {
    const parsed = emailSignupSchema.parse({ email: 'Foo@Example.COM', password: 'password123' });
    expect(parsed.email).toBe('foo@example.com');
  });

  it('login folds the email too', () => {
    const parsed = emailLoginSchema.parse({ email: 'FOO@EXAMPLE.COM', password: 'password123' });
    expect(parsed.email).toBe('foo@example.com');
  });

  it('still rejects a malformed address after folding is applied', () => {
    expect(emailSignupSchema.safeParse({ email: 'NotAnEmail', password: 'password123' }).success).toBe(false);
  });
});

describe('POST /auth/email/signup', () => {
  it('checks for an existing account using the folded address', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/signup',
      payload: { email: 'New.User@Example.COM', password: 'password123' },
    });

    // This is the lookup that returns EMAIL_EXISTS; querying the raw casing is
    // what let a second account be created for the same person.
    expect(paramsFor('SELECT id FROM users WHERE email')).toEqual(['new.user@example.com']);
  });

  it('stores the folded address on the user row', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/signup',
      payload: { email: 'New.User@Example.COM', password: 'password123' },
    });

    const insert = paramsFor('INSERT INTO users');
    expect(insert?.[1]).toBe('new.user@example.com');
  });
});

describe('POST /auth/email/login', () => {
  it('looks the user up by the folded address, so capitalisation is not a wrong password', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/login',
      payload: { email: 'FOO@Example.com', password: 'password123' },
    });

    expect(paramsFor('WHERE u.email')).toEqual(['foo@example.com']);
  });

  it('rate-limits all capitalisations of one address as a single bucket', async () => {
    // rl:login:<email> — keyed on the raw string, `Foo@x` and `foo@x` each got
    // their own 10-attempt budget, multiplying the brute-force allowance.
    const attempt = (email: string) => app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/login',
      payload: { email, password: 'password123' },
    });

    for (let i = 0; i < 6; i += 1) await attempt('victim@example.com');
    for (let i = 0; i < 6; i += 1) await attempt('VICTIM@EXAMPLE.COM');

    const last = await attempt('Victim@Example.com');
    expect(last.statusCode).toBe(429);
  });
});

describe('POST /auth/social', () => {
  it('folds the email the provider echoes back', async () => {
    // Apple rather than Google: the Google branch is gated behind
    // GOOGLE_CLIENT_IDS, and the email handling under test is shared.
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/social',
      payload: { provider: 'apple', idToken: 'x'.repeat(20) },
    });

    // jose is mocked to return 'Mixed.Case@Example.COM'
    const insert = paramsFor('INSERT INTO users');
    expect(insert?.[1]).toBe('mixed.case@example.com');
  });
});
