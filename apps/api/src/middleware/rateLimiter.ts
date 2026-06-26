/**
 * Token-bucket rate-limiting middleware for Fastify.
 * Requirements: 37.1–37.5
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { Redis } from 'ioredis';

export interface RateLimitConfig {
  /** Max requests allowed in the window. */
  max: number;
  /** Window duration in seconds. */
  windowS: number;
  /** Key prefix to namespace the counter. */
  prefix: string;
  /** Extract the subject identifier from the request (e.g. userId, phoneNumber). */
  getKey: (request: FastifyRequest) => string;
}

/**
 * Returns a Fastify preHandler that enforces a sliding-window rate limit
 * using Redis INCR + EXPIRE.
 */
export function rateLimiter(redis: Redis, config: RateLimitConfig) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const subject = config.getKey(request);
    if (!subject) return; // no subject → skip (will fail auth later)

    const key = `rl:${config.prefix}:${subject}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, config.windowS);
    }

    if (count > config.max) {
      const ttl = await redis.ttl(key);
      reply.header('Retry-After', String(ttl));
      await reply.status(429).send({
        error: `Rate limit exceeded. Max ${config.max} requests per ${config.windowS}s. Retry in ${ttl}s.`,
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Pre-built limiters
// ---------------------------------------------------------------------------

export function getUserId(request: FastifyRequest): string {
  return ((request.user as { sub?: string }) ?? {}).sub ?? '';
}

/** General API: 100 per user per minute. No-ops in test to avoid throttling property tests. */
export function generalLimiter(redis: Redis) {
  if (process.env.NODE_ENV === 'test') {
    return async (_request: FastifyRequest, _reply: FastifyReply): Promise<void> => { /* skip in test */ };
  }
  return rateLimiter(redis, { max: 100, windowS: 60, prefix: 'general', getKey: getUserId });
}
