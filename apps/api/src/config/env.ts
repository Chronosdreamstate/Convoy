import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  // PostgreSQL
  DATABASE_URL: z
    .string()
    .default('postgresql://convoy:convoy@localhost:5432/convoy'),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // JWT
  JWT_SECRET: z.string().min(32).default('change-me-in-production-minimum-32-chars!!'),
  JWT_REFRESH_SECRET: z.string().min(32).default('change-me-refresh-secret-minimum-32-chars'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  // CORS
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:8081')
    .transform((val) => val.split(',').map((o) => o.trim())),

  // Mapbox
  MAPBOX_API_TOKEN: z.string().default('pk.placeholder-set-real-token-in-env'),

  // Agora RTC (PTT audio)
  AGORA_APP_ID: z.string().default(''),
  AGORA_APP_CERTIFICATE: z.string().default(''),

  // SMS (phone-OTP delivery). Required in production — without a provider the
  // OTP is generated but never delivered, so phone sign-in cannot complete.
  SMS_PROVIDER: z.enum(['twilio', 'none']).default('none'),
  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  TWILIO_FROM_NUMBER: z.string().default(''),

  // Object storage for uploads. 'local' (default) writes to UPLOADS_DIR — fine
  // for a single instance with a persistent volume, but ephemeral on most
  // container hosts. 's3' uses any S3-compatible service (AWS S3, Cloudflare
  // R2, DigitalOcean Spaces, Supabase Storage, MinIO) — set S3_ENDPOINT for
  // non-AWS providers.
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  S3_BUCKET: z.string().default(''),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().default(''),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),

  // AWS (legacy — superseded by S3_* above)
  AWS_BUCKET: z.string().default('convoy-media'),

  // Firebase
  FIREBASE_PROJECT_ID: z.string().default('convoy-app'),

  // Migrations
  MIGRATIONS_DIR: z.string().default('./src/db/migrations'),

  // Nominatim (OpenStreetMap geocoding) — contact email required by usage policy
  NOMINATIM_CONTACT_EMAIL: z.string().email().default('support@convoy.app'),

  // File uploads
  BASE_URL: z.string().url().default('http://localhost:3000'),
  UPLOADS_DIR: z.string().default('./uploads'),
});

const INSECURE_JWT_DEFAULTS = new Set([
  'change-me-in-production-minimum-32-chars!!',
  'change-me-refresh-secret-minimum-32-chars',
]);

/**
 * Config that boots fine in development on placeholder defaults but must be set
 * for real before going live — otherwise the server starts successfully while
 * core features (maps/routing, push-to-talk, phone sign-in) are silently
 * broken. Returns a human-readable error per missing item; empty means good.
 * Pure + exported so it can be unit-tested without triggering process.exit.
 */
export function productionConfigErrors(data: Env): string[] {
  const errors: string[] = [];

  if (INSECURE_JWT_DEFAULTS.has(data.JWT_SECRET)) {
    errors.push('JWT_SECRET is the insecure default — set a strong random secret.');
  }
  if (INSECURE_JWT_DEFAULTS.has(data.JWT_REFRESH_SECRET)) {
    errors.push('JWT_REFRESH_SECRET is the insecure default — set a strong random secret.');
  }
  if (data.MAPBOX_API_TOKEN.startsWith('pk.placeholder')) {
    errors.push('MAPBOX_API_TOKEN is the placeholder — routing, geocoding and drive cards will fail. Set a real Mapbox token.');
  }
  if (!data.AGORA_APP_ID || !data.AGORA_APP_CERTIFICATE) {
    errors.push('AGORA_APP_ID / AGORA_APP_CERTIFICATE are empty — push-to-talk cannot mint tokens. Set the Agora credentials.');
  }
  if (data.SMS_PROVIDER === 'none') {
    errors.push('SMS_PROVIDER is "none" — phone OTP cannot be delivered, so phone sign-in cannot complete. Set an SMS provider (e.g. twilio).');
  }
  if (data.SMS_PROVIDER === 'twilio' && (!data.TWILIO_ACCOUNT_SID || !data.TWILIO_AUTH_TOKEN || !data.TWILIO_FROM_NUMBER)) {
    errors.push('SMS_PROVIDER=twilio but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER are incomplete.');
  }
  if (data.STORAGE_PROVIDER === 's3' && (!data.S3_BUCKET || !data.S3_ACCESS_KEY_ID || !data.S3_SECRET_ACCESS_KEY)) {
    errors.push('STORAGE_PROVIDER=s3 but S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are incomplete.');
  }

  return errors;
}

function parseEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment variables:', result.error.format());
    process.exit(1);
  }

  const data = result.data;

  if (data.NODE_ENV === 'production') {
    const errors = productionConfigErrors(data);
    if (errors.length > 0) {
      console.error(
        'FATAL: invalid production configuration — refusing to start:\n' +
          errors.map((e) => `  - ${e}`).join('\n'),
      );
      process.exit(1);
    }
  }

  return data;
}

export const env = parseEnv();
export type Env = z.infer<typeof envSchema>;
