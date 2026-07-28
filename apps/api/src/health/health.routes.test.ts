import Fastify, { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { healthRoutes } from './health.routes';

function buildApp(dbOk: boolean, redisOk: boolean): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(fp(async (i) => {
    i.decorate('db', {
      query: async () => {
        if (!dbOk) throw new Error('db down');
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      },
    } as unknown as Pool);
  }, { name: 'db' }));
  app.register(fp(async (i) => {
    i.decorate('redis', {
      ping: async () => {
        if (!redisOk) throw new Error('redis down');
        return 'PONG';
      },
    } as unknown as Redis);
  }, { name: 'redis' }));
  app.register(healthRoutes);
  return app;
}

async function getHealth(dbOk: boolean, redisOk: boolean) {
  const app = buildApp(dbOk, redisOk);
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/health' });
  await app.close();
  return res;
}

describe('GET /health', () => {
  it('returns 200 and status ok when db and redis are up', async () => {
    const res = await getHealth(true, true);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
    expect(body.redis).toBe('ok');
  });

  it('returns 503 when the database is down (so readiness probes fail)', async () => {
    const res = await getHealth(false, true);
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('degraded');
    expect(body.db).toBe('error');
  });

  it('returns 503 when redis is down', async () => {
    const res = await getHealth(true, false);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).redis).toBe('error');
  });
});
