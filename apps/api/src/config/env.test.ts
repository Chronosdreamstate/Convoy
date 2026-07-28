import { productionConfigErrors, Env } from './env';

function baseProdEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'production',
    PORT: 3000,
    DATABASE_URL: 'postgresql://convoy:convoy@db:5432/convoy',
    REDIS_URL: 'redis://redis:6379',
    JWT_SECRET: 'x'.repeat(40),
    JWT_REFRESH_SECRET: 'y'.repeat(40),
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL: '30d',
    CORS_ORIGINS: ['https://convoy.app'],
    MAPBOX_API_TOKEN: 'pk.real-mapbox-token',
    AGORA_APP_ID: 'agora-app-id',
    AGORA_APP_CERTIFICATE: 'agora-cert',
    SMS_PROVIDER: 'twilio',
    TWILIO_ACCOUNT_SID: 'ACxxxxxxxx',
    TWILIO_AUTH_TOKEN: 'auth-token',
    TWILIO_FROM_NUMBER: '+15550001111',
    AWS_BUCKET: 'convoy-media',
    FIREBASE_PROJECT_ID: 'convoy-app',
    MIGRATIONS_DIR: './src/db/migrations',
    NOMINATIM_CONTACT_EMAIL: 'support@convoy.app',
    BASE_URL: 'https://api.convoy.app',
    UPLOADS_DIR: './uploads',
    ...overrides,
  };
}

describe('productionConfigErrors', () => {
  it('returns no errors when everything critical is configured', () => {
    expect(productionConfigErrors(baseProdEnv())).toEqual([]);
  });

  it('flags the insecure default JWT secrets', () => {
    const errs = productionConfigErrors(baseProdEnv({
      JWT_SECRET: 'change-me-in-production-minimum-32-chars!!',
      JWT_REFRESH_SECRET: 'change-me-refresh-secret-minimum-32-chars',
    }));
    expect(errs.some((e) => e.includes('JWT_SECRET'))).toBe(true);
    expect(errs.some((e) => e.includes('JWT_REFRESH_SECRET'))).toBe(true);
  });

  it('flags a placeholder Mapbox token (routing/geocoding would break)', () => {
    const errs = productionConfigErrors(baseProdEnv({ MAPBOX_API_TOKEN: 'pk.placeholder-set-real-token-in-env' }));
    expect(errs.some((e) => e.includes('MAPBOX_API_TOKEN'))).toBe(true);
  });

  it('flags empty Agora credentials (PTT would break)', () => {
    expect(productionConfigErrors(baseProdEnv({ AGORA_APP_ID: '' })).some((e) => e.includes('AGORA'))).toBe(true);
    expect(productionConfigErrors(baseProdEnv({ AGORA_APP_CERTIFICATE: '' })).some((e) => e.includes('AGORA'))).toBe(true);
  });

  it('flags a missing SMS provider (phone sign-in cannot complete)', () => {
    const errs = productionConfigErrors(baseProdEnv({ SMS_PROVIDER: 'none' }));
    expect(errs.some((e) => e.includes('SMS_PROVIDER'))).toBe(true);
  });

  it('flags incomplete Twilio credentials', () => {
    const errs = productionConfigErrors(baseProdEnv({ TWILIO_AUTH_TOKEN: '' }));
    expect(errs.some((e) => e.includes('TWILIO'))).toBe(true);
  });
});
