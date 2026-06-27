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

  // AWS
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

function parseEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment variables:', result.error.format());
    process.exit(1);
  }

  const data = result.data;

  if (data.NODE_ENV === 'production') {
    if (INSECURE_JWT_DEFAULTS.has(data.JWT_SECRET)) {
      console.error('FATAL: JWT_SECRET is set to the insecure default value. Set a strong random secret before deploying.');
      process.exit(1);
    }
    if (INSECURE_JWT_DEFAULTS.has(data.JWT_REFRESH_SECRET)) {
      console.error('FATAL: JWT_REFRESH_SECRET is set to the insecure default value. Set a strong random secret before deploying.');
      process.exit(1);
    }
  }

  return data;
}

export const env = parseEnv();
export type Env = z.infer<typeof envSchema>;
