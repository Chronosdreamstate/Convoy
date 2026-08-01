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
import { sendOtpSms } from './sms';
import { normalizeEmail } from './email';
import { env } from '../config/env';

// ---------------------------------------------------------------------------
// Provider token verification (Bug 1 fix)
// ---------------------------------------------------------------------------

const PROVIDER_JWKS_URLS: Record<'google' | 'apple', string> = {
  google: 'https://www.googleapis.com/oauth2/v3/certs',
  apple: 'https://appleid.apple.com/auth/keys',
};

/** Issuer values each provider may legitimately place in the `iss` claim.
 * Google historically mints tokens both with and without the scheme prefix. */
const PROVIDER_ISSUERS: Record<'google' | 'apple', string[]> = {
  google: ['https://accounts.google.com', 'accounts.google.com'],
  apple: ['https://appleid.apple.com'],
};

/**
 * OAuth client IDs we accept as the `aud` claim of a Google ID token — the
 * app's iOS / Android / web client IDs, comma-separated (same convention as
 * CORS_ORIGINS). Read from process.env on each call rather than config/env so
 * the feature stays optional: when unset, Google sign-in is not configured and
 * POST /auth/social returns 503 for provider=google instead of accepting
 * tokens minted for arbitrary apps.
 */
function getGoogleClientIds(): string[] {
  return (process.env.GOOGLE_CLIENT_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * Client IDs we accept as the `aud` claim of an Apple identity token — the
 * app's bundle ID (and Services ID for web flows), comma-separated, same
 * convention as GOOGLE_CLIENT_IDS. Read from process.env on each call so the
 * feature stays optional. Unlike Google there is no 503 gate when unset:
 * Apple sign-in predates this env var, so unset keeps the historical
 * behavior (signature/expiry/issuer checks, no audience pin) and the server
 * logs a startup warning instead of breaking dev environments.
 */
function getAppleClientIds(): string[] {
  return (process.env.APPLE_CLIENT_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

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
  // jose enforces signature + `exp` itself; we additionally pin the issuer,
  // and the audience must be one of our own client IDs — otherwise a valid
  // token minted for ANY app would sign users in. Google is always pinned
  // (a 503 config gate fires before we get here when GOOGLE_CLIENT_IDS is
  // unset); Apple is pinned only when APPLE_CLIENT_IDS is set, preserving the
  // historical unpinned behavior (with a startup warning) for dev setups.
  const appleClientIds = provider === 'apple' ? getAppleClientIds() : [];
  const { payload } = await jwtVerify<JWTPayload>(idToken, JWKS, {
    issuer: PROVIDER_ISSUERS[provider],
    ...(provider === 'google' ? { audience: getGoogleClientIds() } : {}),
    ...(provider === 'apple' && appleClientIds.length > 0 ? { audience: appleClientIds } : {}),
  });

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

/** OTP verification rate-limit: 5 attempts per phone per 10 minutes (Req 37.2).
 * Without this, an attacker gets unlimited guesses at the 6-digit OTP within its
 * 300s TTL — the request-side limit above only caps how often codes are SENT. */
const OTP_VERIFY_LIMIT = 5;
const OTP_VERIFY_WINDOW_SECONDS = 600;

/** Email signup rate-limit: 5 attempts per IP per 15 minutes.
 * Each signup runs a bcrypt hash (cost 10), so without a dedicated limiter an
 * attacker could use this endpoint as a CPU-amplification vector — the global
 * 200 req/min/IP limit still allows ~200 bcrypt hashes per minute per IP.
 * Keyed by IP (not email) because rotating the email is free for an attacker. */
const SIGNUP_LIMIT = 5;
const SIGNUP_WINDOW_SECONDS = 900;

/** Social auth rate-limit: 10 attempts per IP per 15 minutes.
 * Mirrors rl:signup — each attempt costs a JWKS fetch/signature check and a
 * user upsert, and an unlimited endpoint would let an attacker spray stolen
 * or forged ID tokens. Keyed by IP because the provider account is free to
 * rotate for an attacker. */
const SOCIAL_LIMIT = 10;
const SOCIAL_WINDOW_SECONDS = 900;

async function authRoutes(fastify: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  // Startup warning: without APPLE_CLIENT_IDS, Apple identity tokens are
  // accepted with signature/expiry/issuer checks but NO audience pin, so a
  // valid Apple token minted for any other app would sign users in. Kept
  // non-fatal so dev environments work out of the box.
  if (getAppleClientIds().length === 0) {
    fastify.log.warn(
      'APPLE_CLIENT_IDS is not set — Apple sign-in tokens are verified without audience pinning. ' +
        'Set it to your app bundle ID(s) (e.g. app.convoy.mobile) before production.',
    );
  }

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

    // A fresh code voids every guess made against the old one, so clear the
    // verification-attempt counter. Without this, the verify endpoint's 429
    // ("request a new OTP") is a dead end — the new code would still be
    // rejected for the rest of the 10-minute window. Brute-force exposure
    // stays bounded: the request limit above caps an attacker at
    // OTP_RATE_LIMIT × OTP_VERIFY_LIMIT guesses per window.
    await fastify.redis.del(`rl:otpverify:${phone}`);

    // Development/test: return the code so local flows work without SMS.
    if (env.NODE_ENV !== 'production') {
      return reply.send({ message: 'OTP sent', _dev_otp: otp });
    }

    // Production: deliver via the configured SMS provider and never leak the
    // code in the response. A send failure must surface as an error, not a
    // false "OTP sent" — otherwise the user waits for a code that never comes.
    try {
      await sendOtpSms(phone, otp);
    } catch (err) {
      fastify.log.error({ err }, 'OTP SMS delivery failed');
      return reply.serviceUnavailable('Could not send the verification code. Please try again.');
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

    // Brute-force protection: cap verification ATTEMPTS per phone, independent of
    // the request-side limit. Counted before comparison so failed guesses burn quota.
    const verifyKey = `rl:otpverify:${phone}`;
    const attempts = await fastify.redis.incr(verifyKey);
    if (attempts === 1) {
      await fastify.redis.expire(verifyKey, OTP_VERIFY_WINDOW_SECONDS);
    }
    if (attempts > OTP_VERIFY_LIMIT) {
      return reply.tooManyRequests('Too many verification attempts. Please request a new OTP later.');
    }

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

    // Successful verification clears the attempt counter for this phone
    await fastify.redis.del(verifyKey);

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

    // Brute-force / CPU-amplification protection (mirrors rl:otpverify above):
    // counted before any DB or bcrypt work so failed attempts burn quota too.
    const signupKey = `rl:signup:${request.ip}`;
    const signupAttempts = await fastify.redis.incr(signupKey);
    if (signupAttempts === 1) {
      await fastify.redis.expire(signupKey, SIGNUP_WINDOW_SECONDS);
    }
    if (signupAttempts > SIGNUP_LIMIT) {
      return reply.tooManyRequests('Too many signup attempts. Please try again later.');
    }

    // Reject if ANY account already owns this email — not just one with an
    // 'email' provider. A user who signed up via Google/Apple has users.email
    // set but no 'email' provider row; the old provider-scoped check let an
    // attacker who knows that email register email/password onto the victim's
    // existing user row (upsertUserByEmail's ON CONFLICT (email) DO UPDATE
    // returns the victim's id) and then log straight into their account. Email
    // linking must go through an authenticated flow, never unauthenticated signup.
    const existing = await fastify.db.query(
      `SELECT id FROM users WHERE email = $1 LIMIT 1`,
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

    // Successful auth clears the failure counter so a legitimate user isn't
    // locked out by earlier failures (and their own multi-device logins don't
    // burn the budget) — mirrors the OTP-verify path.
    await fastify.redis.del(loginKey);

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

    // Brute-force protection (mirrors rl:signup): counted before any JWKS or
    // DB work so failed attempts burn quota too.
    const socialKey = `rl:social:${request.ip}`;
    const socialAttempts = await fastify.redis.incr(socialKey);
    if (socialAttempts === 1) {
      await fastify.redis.expire(socialKey, SOCIAL_WINDOW_SECONDS);
    }
    if (socialAttempts > SOCIAL_LIMIT) {
      return reply.tooManyRequests('Too many sign-in attempts. Please try again later.');
    }

    // Config gate: without at least one allowed audience we cannot check who
    // a Google ID token was minted for, so the provider is unavailable rather
    // than insecurely permissive. The mobile client hides the live Google
    // button unless its own client IDs are configured, so this is a backstop.
    if (provider === 'google' && getGoogleClientIds().length === 0) {
      return reply.status(503).send({
        error: {
          code: 'PROVIDER_NOT_CONFIGURED',
          message: 'Google sign-in is not available on this server.',
        },
      });
    }

    let providerId: string;
    let email: string | null = null;

    try {
      const verified = await verifyProviderToken(provider, idToken);
      providerId = verified.sub;
      // Providers echo back whatever casing the user typed when they created
      // the account, so this has to be folded like every other email we store
      // — otherwise Google returning "Foo@x.com" for someone who signed up
      // here as "foo@x.com" would create a second, parallel account.
      if (verified.email) {
        email = normalizeEmail(verified.email);
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

    // Atomically consume the stored JTI — GETDEL ensures only one concurrent request can rotate
    const storedJti = await fastify.redis.getdel(`rtk:${userId}`);
    if (storedJti !== presentedJti) {
      // Possible token reuse attack — storedJti was already deleted above, so all sessions are revoked
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
