import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { createRedisClient } from './redis';
import {
  createNotificationQueue,
  createNotificationWorker,
  enqueueNotification,
  NotificationJob,
} from '../notifications/notification.worker';
import { ExpoPushGateway } from '../notifications/push.gateway';
import { PostgresDeviceStore, PostgresPreferenceStore } from '../notifications/db.stores';

declare module 'fastify' {
  interface FastifyInstance {
    enqueueNotification(job: NotificationJob): Promise<void>;
  }
}

async function notificationsPlugin(fastify: FastifyInstance): Promise<void> {
  // BullMQ worker blocks its Redis connection with BLPOP — use dedicated connections
  const queueRedis = createRedisClient();
  const workerRedis = createRedisClient();

  const gateway = new ExpoPushGateway(fastify.db);
  const deviceStore = new PostgresDeviceStore(fastify.db);
  const preferenceStore = new PostgresPreferenceStore(fastify.db);

  const queue = createNotificationQueue(queueRedis);
  const worker = createNotificationWorker(workerRedis, deviceStore, gateway, preferenceStore);

  worker.on('failed', (job, err) => {
    fastify.log.error({ jobId: job?.id, err }, 'notification job failed');
  });

  fastify.decorate('enqueueNotification', async (job: NotificationJob) => {
    await enqueueNotification(queue, job, gateway, deviceStore);
  });

  fastify.addHook('onClose', async () => {
    await Promise.allSettled([
      worker.close(),
      queue.close(),
      queueRedis.quit(),
      workerRedis.quit(),
    ]);
  });
}

export default fp(notificationsPlugin, {
  name: 'notifications',
  dependencies: ['db'],
});
