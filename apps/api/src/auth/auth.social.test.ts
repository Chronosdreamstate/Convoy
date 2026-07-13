/**
 * Unit tests for POST /auth/social — Google sign-in (Req 2.4) alongside the
 * existing Apple path (Req 2.3).
 *
 * Covers:
 *  - Config gating: provider=google returns 503 PROVIDER_NOT_CONFIGURED when
 *    GOOGLE_CLIENT_IDS is unset; Apple is unaffected by that gate.
 *  - Verification options: Google tokens are checked against our own client
 *    IDs (audience) and Google's issuers; Apple keeps its issuer pin.
 *  - Error taxonomy: any provider-token failure returns the opaque
 *    INVALID_CREDENTIALS envelope (Req 2.8).
 *  - Rate limiting: 10 attempts per IP per 15 minutes, keyed per IP (Req 37).
 */

// jose is ESM-only; stub it so ts-jest (CommonJS) can import auth.routes.ts.
// jwtVerify is routed through a controllable mock so each test can decide
// whether provider verification succeeds and inspect the options it was
// given (issuer / audience).
const mockJwtVerify = jest.fn();
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: (...args: unknown[]) => mockJwtVerify(...args),
}));

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import authRoutes from './auth.routes';

const TEST_USER_ROW = {
  id: 'user-social-1',
  display_name: 'driver',
  phone_number: null,
  email: 'driver@example.com',
};

// ---------------------------------------------------------------------------
// Minimal test app factory (mirrors auth.property.test.ts, plus the pieces
// upsertUserBySocial and issueTokens need: a transactional client and setex)
// ---------------------------------------------------------------------------

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(fastifyCookie);
  app.register(fastifyJwt, {
    secret: 'test-secret-that-is-at-least-32-chars-long!!',
    sign: { expiresIn: '15m' },
  });
  app.register(fastifySensible);

  // Mock DB plugin — answers the exact query shapes upsertUserBySocial issues
  app.register(
    fp(async (instance) => {
      const clientQuery = async (sql: string) => {
        if (sql.includes('SELECT user_id FROM auth_providers')) {
          return { rows: [] }; // no existing provider link → create-user path
        }
        if (sql.includes('INSERT INTO users')) {
          return { rows: [{ id: TEST_USER_ROW.id }] };
        }
        if (sql.includes('SELECT id, display_name')) {
          return { rows: [TEST_USER_ROW] };
        }
        return { rows: [] }; // BEGIN/COMMIT/auth_providers/user_settings inserts
      };
      const mockPool = {
        query: clientQuery,
        connect: async () => ({ query: clientQuery, release: () => {} }),
      } as unknown as Pool;
      instance.decorate('db', mockPool);
    }),
    { name: 'db' },
  );

  // Mock Redis plugin — in-memory store with the subset of commands used here
  app.register(
    fp(async (instance) => {
      const store = new Map<string, { value: string; expiry: number | null }>();

      const mockRedis = {
        get: async (key: string): Promise<string | null> => {
          const entry = store.get(key);
          if (!entry) return null;
          if (entry.expiry !== null && Date.now() > entry.expiry) {
            store.delete(key);
            return null;
          }
          return entry.value;
        },
        set: async (key: string, value: string): Promise<void> => {
          store.set(key, { value, expiry: null });
        },
        setex: async (key: string, ttl: number, value: string): Promise<void> => {
          store.set(key, { value, expiry: Date.now() + ttl * 1000 });
        },
        del: async (key: string): Promise<void> => {
          store.delete(key);
        },
        incr: async (key: string): Promise<number> => {
          const entry = store.get(key);
          const next = (entry ? parseInt(entry.value, 10) : 0) + 1;
          store.set(key, { value: String(next), expiry: entry?.expiry ?? null });
          return next;
        },
        expire: async (key: string, ttl: number): Promise<void> => {
          const entry = store.get(key);
          if (entry) {
            store.set(key, { value: entry.value, expiry: Date.now() + ttl * 1000 });
          }
        },
        ping: async () => 'PONG',
        quit: async () => {},
      } as unknown as Redis;

      instance.decorate('redis', mockRedis);
    }),
    { name: 'redis' },
  );

  app.register(authRoutes, { prefix: '/api/v1' });

  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GOOGLE_CLIENT_IDS =
  'ios-client.apps.googleusercontent.com, web-client.apps.googleusercontent.com';

function injectSocial(
  app: FastifyInstance,
  provider: 'google' | 'apple',
  ip = '10.1.0.1',
) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/social',
    remoteAddress: ip,
    payload: { provider, idToken: `${provider}-id-token` },
  });
}

let app: FastifyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  delete process.env.GOOGLE_CLIENT_IDS;
  mockJwtVerify.mockResolvedValue({
    payload: { sub: 'provider-sub-123', email: 'driver@example.com' },
  });
  app = buildTestApp();
  await app.ready();
});

afterEach(async () => {
  delete process.env.GOOGLE_CLIENT_IDS;
  await app.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /auth/social — Google config gating', () => {
  it('returns 503 PROVIDER_NOT_CONFIGURED for google when GOOGLE_CLIENT_IDS is unset', async () => {
    const res = await injectSocial(app, 'google');

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    // The gate fires before any provider verification is attempted.
    expect(mockJwtVerify).not.toHaveBeenCalled();
  });

  it('still signs in Apple users when Google is unconfigured', async () => {
    const res = await injectSocial(app, 'apple');

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { accessToken: string; user: { id: string } };
    expect(body.accessToken.length).toBeGreaterThan(20);
    expect(body.user.id).toBe(TEST_USER_ROW.id);
  });
});

describe('POST /auth/social — Google token verification', () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_IDS = GOOGLE_CLIENT_IDS;
  });

  it('signs in and issues the app JWT + refresh cookie on a valid Google token', async () => {
    const res = await injectSocial(app, 'google');

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      accessToken: string;
      user: { id: string; displayName: string };
    };
    expect(body.accessToken.length).toBeGreaterThan(20);
    expect(body.user).toEqual({ id: TEST_USER_ROW.id, displayName: TEST_USER_ROW.display_name });
    // Refresh token is set as a cookie, same as every other auth path.
    const setCookie = res.headers['set-cookie'];
    expect(String(setCookie)).toContain('refreshToken=');
  });

  it('verifies the token against our client IDs (audience) and Google issuers', async () => {
    await injectSocial(app, 'google');

    expect(mockJwtVerify).toHaveBeenCalledTimes(1);
    const options = mockJwtVerify.mock.calls[0][2] as { issuer: string[]; audience: string[] };
    expect(options.issuer).toEqual(['https://accounts.google.com', 'accounts.google.com']);
    // Comma-separated env value is split and trimmed.
    expect(options.audience).toEqual([
      'ios-client.apps.googleusercontent.com',
      'web-client.apps.googleusercontent.com',
    ]);
  });

  it('pins the Apple issuer (and no audience) for apple tokens', async () => {
    await injectSocial(app, 'apple');

    const options = mockJwtVerify.mock.calls[0][2] as { issuer: string[]; audience?: string[] };
    expect(options.issuer).toEqual(['https://appleid.apple.com']);
    expect(options.audience).toBeUndefined();
  });

  it('returns the opaque INVALID_CREDENTIALS error when verification fails (Req 2.8)', async () => {
    mockJwtVerify.mockRejectedValue(new Error('bad signature'));

    const res = await injectSocial(app, 'google');

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
    expect(body.error.message).toBe('Invalid credentials');
  });

  it('rejects tokens whose payload is missing a sub claim', async () => {
    mockJwtVerify.mockResolvedValue({ payload: { email: 'driver@example.com' } });

    const res = await injectSocial(app, 'google');

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('POST /auth/social — rate limiting', () => {
  it('returns 429 after 10 attempts from the same IP; other IPs unaffected', async () => {
    process.env.GOOGLE_CLIENT_IDS = GOOGLE_CLIENT_IDS;

    // First 10 attempts pass the limiter.
    for (let i = 0; i < 10; i++) {
      const res = await injectSocial(app, 'google', '10.2.0.1');
      expect(res.statusCode).not.toBe(429);
    }

    // 11th and 12th attempts from the same IP are rejected.
    for (let i = 0; i < 2; i++) {
      const res = await injectSocial(app, 'google', '10.2.0.1');
      expect(res.statusCode).toBe(429);
    }

    // A different IP is unaffected (limit is keyed per IP, not global).
    const other = await injectSocial(app, 'google', '10.2.0.2');
    expect(other.statusCode).not.toBe(429);
  });

  it('failed attempts burn quota too (counted before verification)', async () => {
    process.env.GOOGLE_CLIENT_IDS = GOOGLE_CLIENT_IDS;
    mockJwtVerify.mockRejectedValue(new Error('bad signature'));

    for (let i = 0; i < 10; i++) {
      const res = await injectSocial(app, 'google', '10.3.0.1');
      expect(res.statusCode).toBe(401);
    }
    const res = await injectSocial(app, 'google', '10.3.0.1');
    expect(res.statusCode).toBe(429);
  });
});
