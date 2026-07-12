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

/** Builds the Redis counter key for a limiter. Exported so route modules that
 * count non-unit amounts against the same bucket (e.g. hazard bulk sync counts
 * every item in the batch) target exactly the same key as the middleware. */
export function rateLimitKey(prefix: string, subject: string): string {
  return `rl:${prefix}:${subject}`;
}

/**
 * Returns a Fastify preHandler that enforces a sliding-window rate limit
 * using Redis INCR + EXPIRE.
 */
export function rateLimiter(redis: Redis, config: RateLimitConfig) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const subject = config.getKey(request);
    if (!subject) return; // no subject → skip (will fail auth later)

    const key = rateLimitKey(config.prefix, subject);
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

// Named per-user limiter configs (Req 37.1, 37.3, 37.4). Exported so route
// modules that count non-unit amounts against the same bucket (hazard bulk
// sync) and tests can reference the exact caps/windows/prefixes.
// Unlike generalLimiter these stay active under NODE_ENV=test: they replace
// inline limiters that were always live, and their per-route caps are high
// enough not to throttle the test suites.

/** Hazard report creation: 10 per user per hour (Req 37.1). */
export const hazardReportLimit: RateLimitConfig = { max: 10, windowS: 3600, prefix: 'hazard', getKey: getUserId };
export function hazardReportLimiter(redis: Redis) {
  return rateLimiter(redis, hazardReportLimit);
}

/** Friend requests: 20 per user per hour (Req 37.3). */
export const friendRequestLimit: RateLimitConfig = { max: 20, windowS: 3600, prefix: 'friends', getKey: getUserId };
export function friendRequestLimiter(redis: Redis) {
  return rateLimiter(redis, friendRequestLimit);
}

/** Group join requests: 10 per user per hour (Req 37.4). */
export const joinRequestLimit: RateLimitConfig = { max: 10, windowS: 3600, prefix: 'joinreq', getKey: getUserId };
export function joinRequestLimiter(redis: Redis) {
  return rateLimiter(redis, joinRequestLimit);
}
