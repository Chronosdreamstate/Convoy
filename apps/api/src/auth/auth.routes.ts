import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
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
  fastify.post('/auth/email/signup', async (request, reply) => {
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

    // TODO: verify idToken with provider public keys (Apple / Google)
    // For now we decode without verification for development purposes only.
    // In production, verify the signature using provider's JWKS endpoint.
    let providerId: string;
    let email: string | null = null;

    try {
      // Decode without verify — REPLACE with proper verification in production
      const decoded = jwt.decode(idToken) as Record<string, unknown> | null;
      if (!decoded || typeof decoded.sub !== 'string') {
        throw new Error('Invalid token structure');
      }
      providerId = decoded.sub;
      if (typeof decoded.email === 'string') {
        email = decoded.email;
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
    if (!userId) {
      return reply.unauthorized('Invalid token payload');
    }

    // Issue new access token only
    const accessToken = fastify.jwt.sign({ sub: userId });

    return reply.send({ accessToken });
  });

  // -------------------------------------------------------------------------
  // POST /auth/logout
  // -------------------------------------------------------------------------
  fastify.post('/auth/logout', async (_request, reply) => {
    reply.clearCookie('refreshToken', { path: '/' });
    return reply.status(200).send({ message: 'Logged out' });
  });
}

export default authRoutes;
