/**
 * Unit tests for the Redis token-bucket rate limiter middleware.
 * Requirements: 37.1–37.5
 *
 * Covers:
 *  - Requests at or under `max` pass through without touching the reply.
 *  - Request max+1 within the window gets 429 with a Retry-After header.
 *  - EXPIRE is set exactly once, on the first request of a window.
 *  - Requests with no subject (unauthenticated) skip the limiter entirely.
 *  - getUserId extracts request.user.sub and tolerates missing user.
 *  - generalLimiter is a no-op under NODE_ENV=test.
 */

import { FastifyReply, FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import fc from 'fast-check';
import { rateLimiter, getUserId, generalLimiter, RateLimitConfig } from './rateLimiter';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface FakeRedis {
  redis: Redis;
  counters: Map<string, number>;
  expireCalls: { key: string; ttl: number }[];
  ttlValue: number;
}

function makeFakeRedis(ttlValue = 42): FakeRedis {
  const counters = new Map<string, number>();
  const expireCalls: { key: string; ttl: number }[] = [];

  const redis = {
    incr: jest.fn(async (key: string) => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    }),
    expire: jest.fn(async (key: string, ttl: number) => {
      expireCalls.push({ key, ttl });
      return 1;
    }),
    ttl: jest.fn(async () => ttlValue),
  } as unknown as Redis;

  return { redis, counters, expireCalls, ttlValue };
}

interface FakeReply {
  reply: FastifyReply;
  statusCode: number | null;
  headers: Record<string, string>;
  sentBody: unknown;
}

function makeFakeReply(): FakeReply {
  const state: FakeReply = {
    reply: null as unknown as FastifyReply,
    statusCode: null,
    headers: {},
    sentBody: undefined,
  };

  const reply: Record<string, unknown> = {};
  reply.header = jest.fn((name: string, value: string) => {
    state.headers[name] = value;
    return reply;
  });
  reply.status = jest.fn((code: number) => {
    state.statusCode = code;
    return reply;
  });
  reply.send = jest.fn(async (body: unknown) => {
    state.sentBody = body;
  });

  state.reply = reply as unknown as FastifyReply;
  return state;
}

function makeRequest(userId?: string): FastifyRequest {
  return { user: userId !== undefined ? { sub: userId } : undefined } as unknown as FastifyRequest;
}

const baseConfig: RateLimitConfig = {
  max: 3,
  windowS: 60,
  prefix: 'test',
  getKey: getUserId,
};

// ---------------------------------------------------------------------------
// Under / at the limit
// ---------------------------------------------------------------------------

describe('rateLimiter — requests within the limit', () => {
  it('does not touch the reply for the first `max` requests', async () => {
    const { redis } = makeFakeRedis();
    const limiter = rateLimiter(redis, baseConfig);

    for (let i = 0; i < baseConfig.max; i++) {
      const { reply, statusCode } = makeFakeReply();
      await limiter(makeRequest('u1'), reply);
      expect(statusCode).toBeNull();
    }
  });

  it('sets EXPIRE exactly once — on the first request of the window', async () => {
    const { redis, expireCalls } = makeFakeRedis();
    const limiter = rateLimiter(redis, baseConfig);

    for (let i = 0; i < 3; i++) {
      const { reply } = makeFakeReply();
      await limiter(makeRequest('u1'), reply);
    }

    expect(expireCalls).toHaveLength(1);
    expect(expireCalls[0]).toEqual({ key: 'rl:test:u1', ttl: 60 });
  });

  it('namespaces counters per subject — one user cannot exhaust another\'s quota', async () => {
    const { redis } = makeFakeRedis();
    const limiter = rateLimiter(redis, baseConfig);

    // u1 uses the entire quota
    for (let i = 0; i < baseConfig.max; i++) {
      await limiter(makeRequest('u1'), makeFakeReply().reply);
    }

    // u2 is unaffected
    const fake = makeFakeReply();
    await limiter(makeRequest('u2'), fake.reply);
    expect(fake.statusCode).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Over the limit
// ---------------------------------------------------------------------------

describe('rateLimiter — requests over the limit', () => {
  it('returns 429 with Retry-After on request max+1', async () => {
    const { redis, ttlValue } = makeFakeRedis(17);
    const limiter = rateLimiter(redis, baseConfig);

    for (let i = 0; i < baseConfig.max; i++) {
      await limiter(makeRequest('u1'), makeFakeReply().reply);
    }

    const fake = makeFakeReply();
    await limiter(makeRequest('u1'), fake.reply);

    expect(fake.statusCode).toBe(429);
    expect(fake.headers['Retry-After']).toBe(String(ttlValue));
    expect(fake.sentBody).toEqual({
      error: expect.stringContaining('Rate limit exceeded'),
    });
  });

  it('for any max in 1..20, exactly requests max+1.. get 429', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 5 }),
        async (max, extra) => {
          const { redis } = makeFakeRedis();
          const limiter = rateLimiter(redis, { ...baseConfig, max });

          let rejected = 0;
          for (let i = 0; i < max + extra; i++) {
            const fake = makeFakeReply();
            await limiter(makeRequest('u1'), fake.reply);
            if (fake.statusCode === 429) rejected++;
          }
          expect(rejected).toBe(extra);
        },
      ),
      { numRuns: 25 },
    );
  });
});

// ---------------------------------------------------------------------------
// No subject
// ---------------------------------------------------------------------------

describe('rateLimiter — missing subject', () => {
  it('skips the limiter entirely when getKey returns an empty string', async () => {
    const { redis } = makeFakeRedis();
    const limiter = rateLimiter(redis, baseConfig);

    const fake = makeFakeReply();
    await limiter(makeRequest(), fake.reply); // no user

    expect(fake.statusCode).toBeNull();
    expect(redis.incr).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getUserId
// ---------------------------------------------------------------------------

describe('getUserId', () => {
  it('extracts sub from request.user', () => {
    expect(getUserId(makeRequest('user-99'))).toBe('user-99');
  });

  it('returns empty string when request.user is missing', () => {
    expect(getUserId({} as unknown as FastifyRequest)).toBe('');
  });

  it('returns empty string when request.user has no sub', () => {
    expect(getUserId({ user: {} } as unknown as FastifyRequest)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// generalLimiter under test env
// ---------------------------------------------------------------------------

describe('generalLimiter', () => {
  it('is a no-op under NODE_ENV=test (never calls redis, never rejects)', async () => {
    expect(process.env.NODE_ENV).toBe('test'); // jest default — guards the assumption
    const { redis } = makeFakeRedis();
    const limiter = generalLimiter(redis);

    for (let i = 0; i < 250; i++) {
      const fake = makeFakeReply();
      await limiter(makeRequest('u1'), fake.reply);
      expect(fake.statusCode).toBeNull();
    }
    expect(redis.incr).not.toHaveBeenCalled();
  });
});
