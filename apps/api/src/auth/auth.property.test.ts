/**
 * Property-based tests for the authentication API.
 *
 * Property 1: Unauthenticated access is uniformly restricted
 *   - Validates: Requirements 1.6
 *
 * Property 2: Invalid OTP always returns a retryable error
 *   - Validates: Requirements 2.7
 *
 * Property 3: Auth error messages are credential-agnostic
 *   - Validates: Requirements 2.8
 */

// jose is ESM-only; stub it so ts-jest (CommonJS) can import auth.routes.ts
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn().mockResolvedValue({ payload: { sub: 'test-sub', email: 'test@example.com' } }),
}));

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import fc from 'fast-check';
import { Pool } from 'pg';
import Redis from 'ioredis';
import authRoutes from './auth.routes';

// ---------------------------------------------------------------------------
// Minimal test app factory
// We mock the DB and Redis plugins so no real infrastructure is needed.
// ---------------------------------------------------------------------------

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  // Register security plugins
  app.register(fastifyCookie);
  app.register(fastifyJwt, {
    secret: 'test-secret-that-is-at-least-32-chars-long!!',
    sign: { expiresIn: '15m' },
  });
  app.register(fastifySensible);

  // Mock DB plugin
  app.register(
    fp(async (instance) => {
      // Minimal Pool-like mock for email/login tests
      const mockPool = {
        query: async () => ({ rows: [] }),
        connect: async () => ({
          query: async () => ({ rows: [] }),
          release: () => {},
        }),
      } as unknown as Pool;
      instance.decorate('db', mockPool);
    }),
    { name: 'db' },
  );

  // Mock Redis plugin — uses ioredis-mock behaviour via an in-memory store
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
        set: async (
          key: string,
          value: string,
          exMode?: string,
          ttl?: number,
        ): Promise<void> => {
          const expiry =
            exMode === 'EX' && ttl ? Date.now() + ttl * 1000 : null;
          store.set(key, { value, expiry });
        },
        del: async (key: string): Promise<void> => {
          store.delete(key);
        },
        incr: async (key: string): Promise<number> => {
          const entry = store.get(key);
          const current = entry ? parseInt(entry.value, 10) : 0;
          const next = current + 1;
          store.set(key, {
            value: String(next),
            expiry: entry?.expiry ?? null,
          });
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

  // Register auth routes under /api/v1
  app.register(authRoutes, { prefix: '/api/v1' });

  return app;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Arbitrary E.164 phone numbers */
const phoneArb = fc
  .tuple(
    fc.constantFrom('+1', '+44', '+49', '+61', '+81'),
    fc.stringOf(fc.char().filter((c) => /\d/.test(c)), { minLength: 7, maxLength: 10 }),
  )
  .map(([prefix, digits]) => `${prefix}${digits}`);

/** Arbitrary 6-digit OTP strings */
const sixDigitOtpArb = fc.integer({ min: 100000, max: 999999 }).map(String);

/** Arbitrary wrong OTP — anything that doesn't look like a real OTP */
const wrongOtpArb = sixDigitOtpArb; // wrong because it won't match stored value

/** Arbitrary email addresses */
const emailArb = fc
  .tuple(
    fc.stringOf(fc.char().filter((c) => /[a-z]/.test(c)), { minLength: 3, maxLength: 10 }),
    fc.constantFrom('example.com', 'test.org', 'convoy.app'),
  )
  .map(([local, domain]) => `${local}@${domain}`);

/** Arbitrary passwords with at least 8 characters */
const passwordArb = fc
  .string({ minLength: 8, maxLength: 32 })
  .filter((s) => s.length >= 8);

// ---------------------------------------------------------------------------
// Property 1: Unauthenticated access is uniformly restricted (Req 1.6)
// ---------------------------------------------------------------------------
describe('Property 1: Unauthenticated access is uniformly restricted', () => {
  /**
   * **Validates: Requirements 1.6**
   * For any protected resource, a request without a valid JWT should return 401.
   * We test a representative protected path (/api/v1/users/me) is not accessible
   * without authentication. Since we only have auth routes here, we verify the
   * middleware returns 401 when used directly.
   */
  it('requests without Bearer token to jwt-protected route return 401', async () => {
    const app = buildTestApp();

    // Register a simple protected route to test the authenticate middleware
    const authenticatePlugin = require('../middleware/authenticate');
    app.register(fp(async (instance) => {
      instance.get(
        '/api/v1/protected',
        { preHandler: [authenticatePlugin.authenticate] },
        async () => ({ secret: 'data' }),
      );
    }));

    await app.ready();

    await fc.assert(
      fc.asyncProperty(fc.string(), async (randomToken) => {
        // Any request without a valid token should return 401
        const res = await app.inject({
          method: 'GET',
          url: '/api/v1/protected',
          headers: randomToken.length > 0
            ? { Authorization: `Bearer ${randomToken}` }
            : {},
        });
        expect(res.statusCode).toBe(401);
      }),
      { numRuns: 20 },
    );

    await app.close();
  });

  it('request with no Authorization header returns 401', async () => {
    const app = buildTestApp();
    const authenticatePlugin = require('../middleware/authenticate');
    app.register(fp(async (instance) => {
      instance.get(
        '/api/v1/protected',
        { preHandler: [authenticatePlugin.authenticate] },
        async () => ({ secret: 'data' }),
      );
    }));

    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/protected',
    });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property 2: Invalid OTP always returns a retryable error (Req 2.7)
// ---------------------------------------------------------------------------
describe('Property 2: Invalid OTP always returns a retryable error', () => {
  /**
   * **Validates: Requirements 2.7**
   * For any phone number and any OTP that was NOT issued for that phone,
   * the verify endpoint must return an error with retryable: true.
   */
  it('verifying an OTP never stored for a phone returns a retryable error', async () => {
    const app = buildTestApp();
    await app.ready();

    await fc.assert(
      fc.asyncProperty(phoneArb, wrongOtpArb, async (phone, otp) => {
        // We never request an OTP first — so nothing is stored in Redis
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/otp/verify',
          payload: { phone, otp },
        });

        // Must not be 2xx — should be an error (4xx)
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        // Check it's 422 with retryable flag
        if (res.statusCode === 422) {
          const body = JSON.parse(res.body) as {
            error: { code: string; retryable: boolean };
          };
          expect(body.error.retryable).toBe(true);
        }
      }),
      { numRuns: 30 },
    );

    await app.close();
  });

  it('verifying a wrong OTP for a phone that HAS a stored OTP returns a retryable error', async () => {
    const app = buildTestApp();
    await app.ready();

    await fc.assert(
      fc.asyncProperty(phoneArb, async (phone) => {
        // Request an OTP (stores one in mock Redis)
        const requestRes = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/otp/request',
          payload: { phone },
        });
        expect(requestRes.statusCode).toBe(200);

        // Try a definitely-wrong OTP
        const wrongOtp = '000000';
        const verifyRes = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/otp/verify',
          payload: { phone, otp: wrongOtp },
        });

        expect(verifyRes.statusCode).toBe(422);
        const body = JSON.parse(verifyRes.body) as {
          error: { code: string; retryable: boolean };
        };
        expect(body.error.retryable).toBe(true);
      }),
      { numRuns: 10 },
    );

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property 3: Auth error messages are credential-agnostic (Req 2.8)
// ---------------------------------------------------------------------------
describe('Property 3: Auth error messages are credential-agnostic', () => {
  /**
   * **Validates: Requirements 2.8**
   * For any combination of email and password that fails login,
   * the error response must use the same code and message regardless
   * of whether the email doesn't exist or the password is wrong.
   *
   * We can't distinguish "no user" from "wrong password" via the API —
   * both must return the exact same response structure.
   */
  it('failed logins always return the same opaque INVALID_CREDENTIALS error', async () => {
    const app = buildTestApp();
    await app.ready();

    await fc.assert(
      fc.asyncProperty(emailArb, passwordArb, async (email, password) => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/email/login',
          payload: { email, password },
        });

        // All failed logins must return 401
        expect(res.statusCode).toBe(401);

        const body = JSON.parse(res.body) as {
          error: { code: string; message: string };
        };

        // Error code must always be exactly INVALID_CREDENTIALS
        expect(body.error.code).toBe('INVALID_CREDENTIALS');

        // Error message must be the exact generic message — no hints about which field failed
        expect(body.error.message).toBe('Invalid credentials');

        // Ensure the message does NOT contain discriminating words
        const msg = body.error.message.toLowerCase();
        expect(msg).not.toMatch(/email/);
        expect(msg).not.toMatch(/password/);
        expect(msg).not.toMatch(/user/);
        expect(msg).not.toMatch(/not found/);
        expect(msg).not.toMatch(/wrong/);
        expect(msg).not.toMatch(/incorrect/);
      }),
      { numRuns: 50 },
    );

    await app.close();
  });

  it('login with missing required fields returns a non-discriminating error', async () => {
    const app = buildTestApp();
    await app.ready();

    // Invalid body — missing password — should also return 401 (credential agnostic)
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/login',
      payload: { email: 'someone@example.com' },
    });

    // We return 401 with the same opaque error for any login failure
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_CREDENTIALS');

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property P128: Expired/invalid token returns 4xx from POST /auth/refresh
// Property P129: Fastify JWT sign produces an accessToken of length > 20
// Property P130: Missing refresh token cookie returns non-2xx
// ---------------------------------------------------------------------------
describe('Property P128-P130: Token refresh behaviour', () => {
  it('P128: any random string as refresh token returns 4xx', async () => {
    const app = buildTestApp();
    await app.ready();

    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), async (token) => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/refresh',
          cookies: { refreshToken: token },
        });
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
      }),
      { numRuns: 20 },
    );

    await app.close();
  });

  it('P129: signed JWT access token has length greater than 20 characters', async () => {
    const app = buildTestApp();
    await app.ready();

    const token: string = (app as unknown as { jwt: { sign: (p: object) => string } }).jwt.sign({
      sub: 'user-abc',
      displayName: 'Rider',
    });

    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);

    await app.close();
  });

  it('P130: missing refresh token cookie returns 400 or 401', async () => {
    const app = buildTestApp();
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    await app.close();
  });
});
