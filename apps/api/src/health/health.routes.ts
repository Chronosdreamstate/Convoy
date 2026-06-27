import { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/authenticate';

export async function healthRoutes(fastify: FastifyInstance) {
  // Public health check (no auth)
  fastify.get('/health', async (req, reply) => {
    let dbOk = false;
    let redisOk = false;
    try {
      await fastify.db.query('SELECT 1');
      dbOk = true;
    } catch {}
    try {
      await fastify.redis.ping();
      redisOk = true;
    } catch {}
    const uptime = process.uptime();
    const mem = process.memoryUsage();
    const allOk = dbOk && redisOk;
    reply.send({
      status: allOk ? 'ok' : 'degraded',
      uptime: Math.floor(uptime),
      timestamp: new Date().toISOString(),
      db: dbOk ? 'ok' : 'error',
      redis: redisOk ? 'ok' : 'error',
      memory: {
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
        rssMb: Math.round(mem.rss / 1024 / 1024),
      },
      version: process.env.npm_package_version ?? '0.0.1',
    });
  });

  // Protected metrics (requires auth)
  fastify.get('/metrics', { preHandler: [authenticate] }, async (_req, reply) => {
    const [userCount, groupCount, activeConvoys] = await Promise.all([
      fastify.db.query('SELECT COUNT(*) FROM users').then(r => parseInt(r.rows[0].count, 10)).catch(() => 0),
      fastify.db.query('SELECT COUNT(*) FROM convoy_groups').then(r => parseInt(r.rows[0].count, 10)).catch(() => 0),
      fastify.db.query("SELECT COUNT(*) FROM convoy_groups WHERE status = 'active'").then(r => parseInt(r.rows[0].count, 10)).catch(() => 0),
    ]);
    return reply.send({ userCount, groupCount, activeConvoys, uptime: Math.floor(process.uptime()) });
  });
}
