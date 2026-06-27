import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import {
  otpRequestSchema,
  otpVerifySchema,
  emailSignupSchema,
  emailLoginSchema,
  socialAuthSchema,
} from './auth.schemas';
import {
  requestOtp,
  verifyOtp,
  upsertUserByPhone,
  upsertUserByEmail,
  upsertUserBySocial,
  issueTokens,
  setRefreshCookie,
} from './auth.service';
import { env } from '../config/env';

// ---------------------------------------------------------------------------
// Provider token verification (Bug 1 fix)
// ---------------------------------------------------------------------------

const PROVIDER_JWKS_URLS: Record<'google' | 'apple', string> = {
  google: 'https://www.googleapis.com/oauth2/v3/certs',
  apple: 'https://appleid.apple.com/auth/keys',
};

/** In-memory JWKS cache entry */
interface JwksCache {
  keySet: ReturnType<typeof createRemoteJWKSet>;
  expiresAt: number;
}

const jwksCache = new Map<string, JwksCache>();
const JWKS_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getJwks(provider: 'google' | 'apple'): ReturnType<typeof createRemoteJWKSet> {
  const now = Date.now();
  const cached = jwksCache.get(provider);
  if (cached && cached.expiresAt > now) {
    return cached.keySet;
  }
  const keySet = createRemoteJWKSet(new URL(PROVIDER_JWKS_URLS[provider]));
  jwksCache.set(provider, { keySet, expiresAt: now + JWKS_TTL_MS });
  return keySet;
}

/**
 * Verify an ID token issued by Google or Apple using their published JWKS.
 * Returns the `sub` (provider user ID) and optional `email` on success.
 * Throws on any verification failure.
 */
async function verifyProviderToken(
  provider: 'google' | 'apple',
  idToken: string,
): Promise<{ sub: string; email?: string }> {
  const JWKS = getJwks(provider);
  const { payload } = await jwtVerify<JWTPayload>(idToken, JWKS);

  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new Error('Token missing sub claim');
  }

  return {
    sub: payload.sub,
    ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
  };
}

const BCRYPT_ROUNDS = 10;

/** OTP rate-limit: 5 requests per phone per 10 minutes */
const OTP_RATE_LIMIT = 5;
const OTP_RATE_WINDOW_SECONDS = 600; // 10 minutes

async function authRoutes(fastify: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  // -------------------------------------------------------------------------
  // POST /auth/otp/request
  // -------------------------------------------------------------------------
  fastify.post('/auth/otp/request', async (request, reply) => {
    const result = otpRequestSchema.safeParse(request.body);
    if (!result.success) {
      return reply.badRequest(result.error.errors[0].message);
    }

    const { phone } = result.data;
    const rlKey = `rl:otp:${phone}`;

    // Rate-limit check
    const current = await fastify.redis.incr(rlKey);
    if (current === 1) {
      // Set expiry only on first request in the window
      await fastify.redis.expire(rlKey, OTP_RATE_WINDOW_SECONDS);
    }
    if (current > OTP_RATE_LIMIT) {
      return reply.tooManyRequests('Too many OTP requests. Please try again later.');
    }

    const otp = await requestOtp(phone, fastify.redis);

    // In production, OTP is sent via SMS provider — do not return it in the response.
    // We return it here for development/mock purposes.
    if (env.NODE_ENV !== 'production') {
      return reply.send({ message: 'OTP sent', _dev_otp: otp });
    }

    return reply.send({ message: 'OTP sent' });
  });

  // -------------------------------------------------------------------------
  // POST /auth/otp/verify
  // -------------------------------------------------------------------------
  fastify.post('/auth/otp/verify', async (request, reply) => {
    const result = otpVerifySchema.safeParse(request.body);
    if (!result.success) {
      return reply.badRequest(result.error.errors[0].message);
    }

    const { phone, otp } = result.data;

    try {
      await verifyOtp(phone, otp, fastify.redis);
    } catch {
      return reply.status(422).send({
        error: {
          code: 'INVALID_OTP',
          message: 'Invalid or expired OTP. Please request a new one.',
          retryable: true,
        },
      });
    }

    const user = await upsertUserByPhone(phone, fastify.db);
    const { accessToken, refreshToken } = await issueTokens(user.id, fastify);
    setRefreshCookie(reply, refreshToken, env.NODE_ENV);

    return reply.send({
      accessToken,
      user: {
        id: user.id,
        displayName: user.display_name,
      },
    });
  });

  // -------------------------------------------------------------------------
  // POST /auth/email/signup
  // -------------------------------------------------------------------------
  fastify.post('/auth/email/signup', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email', maxLength: 254 },
          password: { type: 'string', minLength: 8, maxLength: 128 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const result = emailSignupSchema.safeParse(request.body);
    if (!result.success) {
      return reply.badRequest(result.error.errors[0].message);
    }

    const { email, password } = result.data;

    // Reject if this email already has an email auth provider (prevents duplicate rows)
    const existing = await fastify.db.query(
      `SELECT u.id FROM users u
       JOIN auth_providers ap ON ap.user_id = u.id AND ap.provider = 'email'
       WHERE u.email = $1 LIMIT 1`,
      [email],
    );
    if (existing.rows.length > 0) {
      return reply.status(409).send({
        error: { code: 'EMAIL_EXISTS', message: 'An account with this email already exists.' },
      });
    }

    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const user = await upsertUserByEmail(email, hashedPassword, fastify.db);
    const { accessToken, refreshToken } = await issueTokens(user.id, fastify);
    setRefreshCookie(reply, refreshToken, env.NODE_ENV);

    return reply.status(201).send({
      accessToken,
      user: {
        id: user.id,
        displayName: user.display_name,
      },
    });
  });

  // -------------------------------------------------------------------------
  // POST /auth/email/login
  // -------------------------------------------------------------------------
  fastify.post('/auth/email/login', async (request, reply) => {
    const result = emailLoginSchema.safeParse(request.body);
    if (!result.success) {
      // Return generic error — never reveal which field failed
      return reply.status(401).send({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' },
      });
    }

    const { email, password } = result.data;

    // Brute-force protection: max 10 login attempts per email per 15 min
    const loginKey = `rl:login:${email}`;
    const attempts = await fastify.redis.incr(loginKey);
    if (attempts === 1) await fastify.redis.expire(loginKey, 900);
    if (attempts > 10) {
      return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Try again later.' } });
    }

    // Look up the user by email
    const userResult = await fastify.db.query<{
      id: string;
      display_name: string;
      email: string | null;
    }>(
      `SELECT u.id, u.display_name, u.email, ap.provider_id AS hashed_password
       FROM users u
       JOIN auth_providers ap ON ap.user_id = u.id AND ap.provider = 'email'
       WHERE u.email = $1
       LIMIT 1`,
      [email],
    );

    const row = userResult.rows[0] as
      | (typeof userResult.rows[0] & { hashed_password: string })
      | undefined;

    // Use constant-time compare even on missing user to avoid timing attacks
    const dummyHash = '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const hashToCompare = row?.hashed_password ?? dummyHash;
    const passwordValid = await bcrypt.compare(password, hashToCompare);

    if (!row || !passwordValid) {
      return reply.status(401).send({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' },
      });
    }

    const { accessToken, refreshToken } = await issueTokens(row.id, fastify);
    setRefreshCookie(reply, refreshToken, env.NODE_ENV);

    return reply.send({
      accessToken,
      user: {
        id: row.id,
        displayName: row.display_name,
      },
    });
  });

  // -------------------------------------------------------------------------
  // POST /auth/social
  // -------------------------------------------------------------------------
  fastify.post('/auth/social', async (request, reply) => {
    const result = socialAuthSchema.safeParse(request.body);
    if (!result.success) {
      return reply.badRequest(result.error.errors[0].message);
    }

    const { provider, idToken } = result.data;

    let providerId: string;
    let email: string | null = null;

    try {
      const verified = await verifyProviderToken(provider, idToken);
      providerId = verified.sub;
      if (verified.email) {
        email = verified.email;
      }
    } catch {
      return reply.status(401).send({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' },
      });
    }

    const user = await upsertUserBySocial(provider, providerId, email, fastify.db);
    const { accessToken, refreshToken } = await issueTokens(user.id, fastify);
    setRefreshCookie(reply, refreshToken, env.NODE_ENV);

    return reply.send({
      accessToken,
      user: {
        id: user.id,
        displayName: user.display_name,
      },
    });
  });

  // -------------------------------------------------------------------------
  // POST /auth/refresh
  // -------------------------------------------------------------------------
  fastify.post('/auth/refresh', async (request, reply) => {
    const token = request.cookies?.refreshToken;
    if (!token) {
      return reply.unauthorized('No refresh token provided');
    }

    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as jwt.JwtPayload;
    } catch {
      return reply.unauthorized('Invalid or expired refresh token');
    }

    const userId = payload.sub;
    const presentedJti = payload.jti;
    if (!userId) {
      return reply.unauthorized('Invalid token payload');
    }

    // All tokens issued by issueTokens() include a JTI. Tokens without one are either
    // legacy (pre-JTI) or tampered — reject them to enforce replay protection.
    if (!presentedJti) {
      return reply.unauthorized('Invalid refresh token format');
    }

    // Verify the jti matches the last-issued token — rejects replayed or rotated-out tokens
    const storedJti = await fastify.redis.get(`rtk:${userId}`);
    if (storedJti !== presentedJti) {
      // Possible token reuse attack — invalidate all refresh tokens for this user
      await fastify.redis.del(`rtk:${userId}`);
      return reply.unauthorized('Refresh token has already been used or revoked');
    }

    // Verify the user still exists in the database
    const userCheck = await fastify.db.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1`,
      [userId],
    );
    if (userCheck.rows.length === 0) {
      return reply.unauthorized('User not found');
    }

    // Rotate: issue both a new access token AND a new refresh token (stores new jti in Redis)
    const { accessToken, refreshToken: newRefreshToken } = await issueTokens(userId, fastify);
    setRefreshCookie(reply, newRefreshToken, env.NODE_ENV);

    return reply.send({ accessToken });
  });

  // -------------------------------------------------------------------------
  // POST /auth/logout
  // -------------------------------------------------------------------------
  fastify.post('/auth/logout', async (request, reply) => {
    // Invalidate the refresh token jti if the user is authenticated
    const token = request.cookies?.refreshToken;
    if (token) {
      try {
        const payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as jwt.JwtPayload;
        if (payload.sub) {
          await fastify.redis.del(`rtk:${payload.sub}`);
        }
      } catch {
        // Token already expired or invalid — nothing to invalidate
      }
    }
    reply.clearCookie('refreshToken', { path: '/' });
    return reply.status(200).send({ message: 'Logged out' });
  });
}

export default authRoutes;
