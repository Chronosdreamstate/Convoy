import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { env } from '../config/env';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}

export function createRedisClient(url?: string, maxRetriesPerRequest: number | null = 3): Redis {
  const client = new Redis(url ?? env.REDIS_URL, {
    maxRetriesPerRequest,
    enableReadyCheck: true,
    lazyConnect: false,
    // Bounds the ref'd force-destroy fallback timer ioredis arms on every
    // forced disconnect (AbstractConnector.disconnect: stream.end() +
    // setTimeout(destroy, disconnectTimeout)). The default is 2000ms, and it
    // always ran to completion on shutdown: BullMQ's worker.close() ends with
    // a fire-and-forget client.disconnect() on its blocking connection (a
    // duplicate() of the client we pass in, so it inherits this option), and
    // that connection sits inside a blocking command the server won't
    // half-close — leaving ~2s of ref'd timers per worker AFTER app.close()
    // had resolved (jest then warned it "did not exit"). 50ms is plenty for a
    // graceful FIN on a loopback/LAN Redis and keeps teardown prompt.
    disconnectTimeout: 50,
  });

  client.on('error', (err) => {
    console.error('[Redis] connection error:', err.message);
  });

  return client;
}

async function redisPlugin(fastify: FastifyInstance) {
  const redis = createRedisClient();

  await redis.ping(); // Verify connection on startup

  fastify.decorate('redis', redis);

  fastify.addHook('onClose', async () => {
    await redis.quit();
  });
}

export default fp(redisPlugin, {
  name: 'redis',
});
