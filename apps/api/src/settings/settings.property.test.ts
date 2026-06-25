/**
 * Property tests for user settings API.
 *
 * Property 52: Settings constraints are always enforced
 *   Validates: Requirements 16.1–16.5
 *
 * Property 53: PATCH /settings updates only specified fields
 *   Validates: Requirements 16.1–16.5
 *
 * Property 54: GET /settings always returns a valid settings shape
 *   Validates: Requirements 16.1–16.5
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import fc from 'fast-check';
import { Pool } from 'pg';
import Redis from 'ioredis';
import settingsRoutes from './settings.routes';

// ---------------------------------------------------------------------------
// In-memory settings store
// ---------------------------------------------------------------------------
interface SettingsRow {
  user_id: string;
  hazard_alert_distance_m: number;
  ptt_max_seconds: number;
  tile_cache_limit_mb: number;
  scenic_routing: boolean;
  map_style: string;
  notif_hazard: boolean;
  notif_group_events: boolean;
  notif_friend_requests: boolean;
  notif_navigation: boolean;
}

const DEFAULTS: Omit<SettingsRow, 'user_id'> = {
  hazard_alert_distance_m: 805,
  ptt_max_seconds: 30,
  tile_cache_limit_mb: 500,
  scenic_routing: false,
  map_style: 'standard',
  notif_hazard: true,
  notif_group_events: true,
  notif_friend_requests: true,
  notif_navigation: true,
};

let settingsStore: Map<string, SettingsRow>;

function resetStore() {
  settingsStore = new Map();
}

function buildMockPool(): Pool {
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      const norm = sql.replace(/\s+/g, ' ').trim().toUpperCase();

      // INSERT ON CONFLICT DO NOTHING — auto-seed defaults
      if (norm.includes('INSERT INTO USER_SETTINGS') && norm.includes('ON CONFLICT DO NOTHING')) {
        const userId = params![0] as string;
        if (!settingsStore.has(userId)) {
          settingsStore.set(userId, { user_id: userId, ...DEFAULTS });
        }
        return { rows: [], rowCount: 0 };
      }

      // SELECT * FROM user_settings WHERE user_id = $1
      if (norm.includes('SELECT * FROM USER_SETTINGS')) {
        const userId = params![0] as string;
        const row = settingsStore.get(userId);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }

      // UPDATE user_settings SET ... WHERE user_id = $N RETURNING *
      if (norm.includes('UPDATE USER_SETTINGS SET')) {
        const allValues = params as unknown[];
        const userId = allValues[allValues.length - 1] as string;
        const row = settingsStore.get(userId);
        if (!row) return { rows: [], rowCount: 0 };

        // Reconstruct which columns were updated from the SQL SET clause
        const setSection = sql.match(/SET (.+?) WHERE/s)?.[1] ?? '';
        const colValues: Record<string, unknown> = {};
        const pairs = setSection.split(',').map((s) => s.trim());
        let valueIdx = 0;
        for (const pair of pairs) {
          const col = pair.split('=')[0].trim().toLowerCase();
          colValues[col] = allValues[valueIdx++];
        }

        const updated: SettingsRow = { ...row };
        if ('hazard_alert_distance_m' in colValues) updated.hazard_alert_distance_m = colValues['hazard_alert_distance_m'] as number;
        if ('ptt_max_seconds' in colValues) updated.ptt_max_seconds = colValues['ptt_max_seconds'] as number;
        if ('tile_cache_limit_mb' in colValues) updated.tile_cache_limit_mb = colValues['tile_cache_limit_mb'] as number;
        if ('scenic_routing' in colValues) updated.scenic_routing = colValues['scenic_routing'] as boolean;
        if ('map_style' in colValues) updated.map_style = colValues['map_style'] as string;
        if ('notif_hazard' in colValues) updated.notif_hazard = colValues['notif_hazard'] as boolean;
        if ('notif_group_events' in colValues) updated.notif_group_events = colValues['notif_group_events'] as boolean;
        if ('notif_friend_requests' in colValues) updated.notif_friend_requests = colValues['notif_friend_requests'] as boolean;
        if ('notif_navigation' in colValues) updated.notif_navigation = colValues['notif_navigation'] as boolean;

        settingsStore.set(userId, updated);
        return { rows: [updated], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
  } as unknown as Pool;
  return pool;
}

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);
  app.register(fastifyJwt, {
    secret: 'test-secret-that-is-at-least-32-chars-long!!',
    sign: { expiresIn: '15m' },
  });
  app.register(fastifySensible);

  app.register(fp(async (inst) => { inst.decorate('db', buildMockPool()); }, { name: 'db' }));
  app.register(fp(async (inst) => { inst.decorate('redis', {} as Redis); }, { name: 'redis' }));

  app.register(settingsRoutes, { prefix: '/api/v1' });
  return app;
}

async function makeToken(app: FastifyInstance, userId: string): Promise<string> {
  await app.ready();
  return app.jwt.sign({ sub: userId });
}

// ---------------------------------------------------------------------------
// Property 52: Settings constraints are enforced on PATCH
// ---------------------------------------------------------------------------
describe('Property 52: Settings constraints are always enforced', () => {
  it('hazardAlertDistanceM below minimum (100) is rejected with 400', async () => {
    const app = buildTestApp();
    resetStore();
    const token = await makeToken(app, 'u1');

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -10000, max: 99 }),
        async (dist) => {
          const res = await app.inject({
            method: 'PATCH',
            url: '/api/v1/settings',
            headers: { Authorization: `Bearer ${token}` },
            payload: { hazardAlertDistanceM: dist },
          });
          expect(res.statusCode).toBe(400);
        },
      ),
      { numRuns: 20 },
    );
    await app.close();
  });

  it('hazardAlertDistanceM above maximum (80000) is rejected with 400', async () => {
    const app = buildTestApp();
    resetStore();
    const token = await makeToken(app, 'u1');

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 80001, max: 200000 }),
        async (dist) => {
          const res = await app.inject({
            method: 'PATCH',
            url: '/api/v1/settings',
            headers: { Authorization: `Bearer ${token}` },
            payload: { hazardAlertDistanceM: dist },
          });
          expect(res.statusCode).toBe(400);
        },
      ),
      { numRuns: 20 },
    );
    await app.close();
  });

  it('pttMaxSeconds below minimum (5) is rejected with 400', async () => {
    const app = buildTestApp();
    resetStore();
    const token = await makeToken(app, 'u1');

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -100, max: 4 }),
        async (secs) => {
          const res = await app.inject({
            method: 'PATCH',
            url: '/api/v1/settings',
            headers: { Authorization: `Bearer ${token}` },
            payload: { pttMaxSeconds: secs },
          });
          expect(res.statusCode).toBe(400);
        },
      ),
      { numRuns: 20 },
    );
    await app.close();
  });

  it('pttMaxSeconds above maximum (60) is rejected with 400', async () => {
    const app = buildTestApp();
    resetStore();
    const token = await makeToken(app, 'u1');

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 61, max: 1000 }),
        async (secs) => {
          const res = await app.inject({
            method: 'PATCH',
            url: '/api/v1/settings',
            headers: { Authorization: `Bearer ${token}` },
            payload: { pttMaxSeconds: secs },
          });
          expect(res.statusCode).toBe(400);
        },
      ),
      { numRuns: 20 },
    );
    await app.close();
  });

  it('mapStyle must be one of standard/satellite/hybrid', async () => {
    const app = buildTestApp();
    resetStore();
    const token = await makeToken(app, 'u1');

    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((s) => !['standard', 'satellite', 'hybrid'].includes(s) && s.length > 0),
        async (style) => {
          const res = await app.inject({
            method: 'PATCH',
            url: '/api/v1/settings',
            headers: { Authorization: `Bearer ${token}` },
            payload: { mapStyle: style },
          });
          expect(res.statusCode).toBe(400);
        },
      ),
      { numRuns: 20 },
    );
    await app.close();
  });

  it('valid values in range are accepted', async () => {
    const app = buildTestApp();
    resetStore();
    const token = await makeToken(app, 'u1');

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 100, max: 80000 }),
        fc.integer({ min: 5, max: 60 }),
        fc.constantFrom('standard', 'satellite', 'hybrid'),
        async (dist, pttMax, style) => {
          const res = await app.inject({
            method: 'PATCH',
            url: '/api/v1/settings',
            headers: { Authorization: `Bearer ${token}` },
            payload: { hazardAlertDistanceM: dist, pttMaxSeconds: pttMax, mapStyle: style },
          });
          expect(res.statusCode).toBe(200);
          const body = JSON.parse(res.body) as { hazardAlertDistanceM: number; pttMaxSeconds: number; mapStyle: string };
          expect(body.hazardAlertDistanceM).toBe(dist);
          expect(body.pttMaxSeconds).toBe(pttMax);
          expect(body.mapStyle).toBe(style);
        },
      ),
      { numRuns: 20 },
    );
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property 53: PATCH /settings updates only specified fields
// ---------------------------------------------------------------------------
describe('Property 53: PATCH /settings updates only specified fields', () => {
  it('updating one field leaves all others at their previous values', async () => {
    const app = buildTestApp();
    resetStore();
    const userId = 'u-partial';
    const token = await makeToken(app, userId);

    // Seed a known state
    await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { Authorization: `Bearer ${token}` },
    });

    // Patch only scenicRouting
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { Authorization: `Bearer ${token}` },
      payload: { scenicRouting: true },
    });
    expect(patchRes.statusCode).toBe(200);
    const body = JSON.parse(patchRes.body) as {
      scenicRouting: boolean;
      hazardAlertDistanceM: number;
      pttMaxSeconds: number;
      mapStyle: string;
    };

    // Updated field changed
    expect(body.scenicRouting).toBe(true);
    // Other fields kept defaults
    expect(body.hazardAlertDistanceM).toBe(805);
    expect(body.pttMaxSeconds).toBe(30);
    expect(body.mapStyle).toBe('standard');

    await app.close();
  });

  it('PATCH with no fields returns current settings unchanged', async () => {
    const app = buildTestApp();
    resetStore();
    const userId = 'u-noop';
    const token = await makeToken(app, userId);

    // Seed a specific state first
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { Authorization: `Bearer ${token}` },
      payload: { hazardAlertDistanceM: 1500 },
    });

    // Empty patch
    const noopRes = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { Authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(noopRes.statusCode).toBe(200);
    const body = JSON.parse(noopRes.body) as { hazardAlertDistanceM: number };
    expect(body.hazardAlertDistanceM).toBe(1500);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Property 54: GET /settings always returns a valid settings shape
// ---------------------------------------------------------------------------
describe('Property 54: GET /settings always returns a valid settings shape', () => {
  it('first GET auto-seeds defaults and returns valid settings shape', async () => {
    const app = buildTestApp();
    resetStore();
    const token = await makeToken(app, 'u-fresh');

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      hazardAlertDistanceM: number;
      pttMaxSeconds: number;
      tileCacheLimitMb: number;
      scenicRouting: boolean;
      mapStyle: string;
      notifHazard: boolean;
      notifGroupEvents: boolean;
      notifFriendRequests: boolean;
      notifNavigation: boolean;
    };

    expect(typeof body.hazardAlertDistanceM).toBe('number');
    expect(typeof body.pttMaxSeconds).toBe('number');
    expect(typeof body.tileCacheLimitMb).toBe('number');
    expect(typeof body.scenicRouting).toBe('boolean');
    expect(['standard', 'satellite', 'hybrid']).toContain(body.mapStyle);
    expect(typeof body.notifHazard).toBe('boolean');
    expect(typeof body.notifGroupEvents).toBe('boolean');
    expect(typeof body.notifFriendRequests).toBe('boolean');
    expect(typeof body.notifNavigation).toBe('boolean');

    await app.close();
  });

  it('GET /settings is idempotent — multiple calls return the same shape', async () => {
    const app = buildTestApp();
    resetStore();
    const token = await makeToken(app, 'u-idem');

    const r1 = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: { Authorization: `Bearer ${token}` } });
    const r2 = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: { Authorization: `Bearer ${token}` } });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(JSON.parse(r1.body)).toEqual(JSON.parse(r2.body));

    await app.close();
  });

  it('unauthenticated requests return 401', async () => {
    const app = buildTestApp();
    resetStore();
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    expect(res.statusCode).toBe(401);

    await app.close();
  });
});
