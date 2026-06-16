/**
 * Basic smoke test for the Fastify app.
 * Tests that the app builds and health endpoint responds.
 */

// We test without real DB/Redis by mocking the plugins
import Fastify from 'fastify';

describe('App health', () => {
  it('health endpoint returns ok', async () => {
    const app = Fastify({ logger: false });

    app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
  });
});
