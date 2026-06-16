import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { env } from '../config/env';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}

export function createRedisClient(url?: string): Redis {
  const client = new Redis(url ?? env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
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
