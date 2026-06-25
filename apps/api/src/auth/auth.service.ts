import { FastifyInstance, FastifyReply } from 'fastify';
import { Pool } from 'pg';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env';

// 30 days in seconds — must match JWT_REFRESH_TTL config
const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// OTP helpers
// ---------------------------------------------------------------------------

const OTP_TTL_SECONDS = 300;

/**
 * Generate a 6-digit OTP, store it in Redis with a 300s TTL, and return it.
 * In production this would trigger an SMS; here we return it for mock usage.
 */
export async function requestOtp(phone: string, redis: Redis): Promise<string> {
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  await redis.set(`otp:${phone}`, otp, 'EX', OTP_TTL_SECONDS);
  return otp;
}

/**
 * Fetch the stored OTP for the phone, compare, and delete on match.
 * Throws a generic error on mismatch or expiry to avoid revealing state.
 */
export async function verifyOtp(phone: string, otp: string, redis: Redis): Promise<void> {
  const stored = await redis.get(`otp:${phone}`);

  if (!stored || stored !== otp) {
    throw new Error('Invalid or expired OTP');
  }

  await redis.del(`otp:${phone}`);
}

// ---------------------------------------------------------------------------
// User upsert helpers
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  display_name: string;
  phone_number: string | null;
  email: string | null;
}

/**
 * Upsert a user by phone number; upsert an auth_providers row for provider='phone'.
 */
export async function upsertUserByPhone(phone: string, pool: Pool): Promise<UserRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Upsert the users row
    const userResult = await client.query<UserRow>(
      `INSERT INTO users (display_name, phone_number)
       VALUES ($1, $2)
       ON CONFLICT (phone_number)
       DO UPDATE SET updated_at = now()
       RETURNING id, display_name, phone_number, email`,
      [`User ${phone.slice(-4)}`, phone],
    );

    const user = userResult.rows[0];

    // Upsert the auth_providers row
    await client.query(
      `INSERT INTO auth_providers (user_id, provider, provider_id)
       VALUES ($1, 'phone', $2)
       ON CONFLICT (provider, provider_id) DO NOTHING`,
      [user.id, phone],
    );

    // Seed default settings row (no-op for existing users)
    await client.query(
      `INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [user.id],
    );

    await client.query('COMMIT');
    return user;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Upsert a user by email + hashed password; upsert an auth_providers row for provider='email'.
 */
export async function upsertUserByEmail(
  email: string,
  hashedPassword: string,
  pool: Pool,
): Promise<UserRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userResult = await client.query<UserRow>(
      `INSERT INTO users (display_name, email)
       VALUES ($1, $2)
       ON CONFLICT (email)
       DO UPDATE SET updated_at = now()
       RETURNING id, display_name, phone_number, email`,
      [email.split('@')[0], email],
    );

    const user = userResult.rows[0];

    // Upsert auth_providers — conflict on (user_id, provider) since each user
    // can only have one email auth entry; update password hash on re-register
    await client.query(
      `INSERT INTO auth_providers (user_id, provider, provider_id)
       VALUES ($1, 'email', $2)
       ON CONFLICT (user_id, provider) DO UPDATE SET provider_id = EXCLUDED.provider_id`,
      [user.id, hashedPassword],
    );

    // Seed default settings row (no-op for existing users)
    await client.query(
      `INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [user.id],
    );

    await client.query('COMMIT');
    return user;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Upsert a user via a social provider's identity.
 * The provider_id is the external subject/sub from the provider.
 */
export async function upsertUserBySocial(
  provider: 'apple' | 'google',
  providerId: string,
  email: string | null,
  pool: Pool,
): Promise<UserRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check if auth_providers row already exists
    const existingProvider = await client.query<{ user_id: string }>(
      `SELECT user_id FROM auth_providers WHERE provider = $1 AND provider_id = $2`,
      [provider, providerId],
    );

    let userId: string;

    if (existingProvider.rows.length > 0) {
      userId = existingProvider.rows[0].user_id;
      // Update email if provided and not yet set
      if (email) {
        await client.query(
          `UPDATE users SET email = COALESCE(email, $1), updated_at = now() WHERE id = $2`,
          [email, userId],
        );
      }
    } else {
      // Create new user
      const displayName = email ? email.split('@')[0] : `${provider}User`;
      const userResult = await client.query<{ id: string }>(
        `INSERT INTO users (display_name, email)
         VALUES ($1, $2)
         ON CONFLICT (email)
         DO UPDATE SET updated_at = now()
         RETURNING id`,
        [displayName, email],
      );
      userId = userResult.rows[0].id;

      await client.query(
        `INSERT INTO auth_providers (user_id, provider, provider_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (provider, provider_id) DO NOTHING`,
        [userId, provider, providerId],
      );
    }

    // Seed default settings row (no-op for existing users)
    await client.query(
      `INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [userId],
    );

    const userResult = await client.query<UserRow>(
      `SELECT id, display_name, phone_number, email FROM users WHERE id = $1`,
      [userId],
    );

    await client.query('COMMIT');
    return userResult.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Token issuance
// ---------------------------------------------------------------------------

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  jti: string;
}

/**
 * Issue an access token (15 min) via fastify.jwt and a refresh token (30d)
 * directly via jsonwebtoken using JWT_REFRESH_SECRET.
 * Stores the refresh token's jti in Redis so the previous token can be invalidated on rotation.
 */
export async function issueTokens(
  userId: string,
  fastify: FastifyInstance,
): Promise<TokenPair> {
  const jti = randomUUID();

  // Access token — signed by @fastify/jwt (uses JWT_SECRET, TTL = JWT_ACCESS_TTL)
  const accessToken = fastify.jwt.sign({ sub: userId });

  // Refresh token — signed directly with JWT_REFRESH_SECRET; includes jti for rotation
  const refreshToken = jwt.sign({ sub: userId, jti }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL as jwt.SignOptions['expiresIn'],
  });

  // Record the active jti so old tokens can be rejected on next refresh
  await fastify.redis.setex(`rtk:${userId}`, REFRESH_TOKEN_TTL_S, jti);

  return { accessToken, refreshToken, jti };
}

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

/**
 * Set the HttpOnly Secure SameSite=Strict refresh token cookie.
 */
export function setRefreshCookie(
  reply: FastifyReply,
  refreshToken: string,
  nodeEnv: string,
): void {
  reply.setCookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: nodeEnv === 'production', // only enforce HTTPS in production
    sameSite: 'strict',
    path: '/',
    // 30 days in seconds
    maxAge: 30 * 24 * 60 * 60,
  });
}
