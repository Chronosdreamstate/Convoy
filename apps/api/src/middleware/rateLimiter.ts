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
// Pre-built limiters (re-used across route files)
// ---------------------------------------------------------------------------

export function getUserId(request: FastifyRequest): string {
  return ((request.user as { sub?: string }) ?? {}).sub ?? '';
}

/** OTP: 5 per phone per 10 min (Req 37.2) */
export function otpLimiter(redis: Redis) {
  return rateLimiter(redis, {
    max: 5,
    windowS: 600,
    prefix: 'otp',
    getKey: (req) => {
      const body = req.body as { phoneNumber?: string } | undefined;
      return body?.phoneNumber ?? '';
    },
  });
}

/** Hazard submit: 10 per user per hour (Req 37.1) */
export function hazardLimiter(redis: Redis) {
  return rateLimiter(redis, { max: 10, windowS: 3600, prefix: 'hazard', getKey: getUserId });
}

/** Friend request: 20 per user per hour (Req 37.3) */
export function friendRequestLimiter(redis: Redis) {
  return rateLimiter(redis, { max: 20, windowS: 3600, prefix: 'friend_req', getKey: getUserId });
}

/** Group join: 10 per user per hour (Req 37.4) */
export function groupJoinLimiter(redis: Redis) {
  return rateLimiter(redis, { max: 10, windowS: 3600, prefix: 'group_join', getKey: getUserId });
}

/** General API: 100 per user per minute */
export function generalLimiter(redis: Redis) {
  return rateLimiter(redis, { max: 100, windowS: 60, prefix: 'general', getKey: getUserId });
}
