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
  // BullMQ worker blocks its Redis connection with BLPOP — use dedicated connections.
  // BullMQ requires maxRetriesPerRequest: null on the worker's connection.
  const queueRedis = createRedisClient();
  const workerRedis = createRedisClient(undefined, null);

  const gateway = new ExpoPushGateway(fastify.db);
  const deviceStore = new PostgresDeviceStore(fastify.db);
  const preferenceStore = new PostgresPreferenceStore(fastify.db);

  const queue = createNotificationQueue(queueRedis);
  const worker = createNotificationWorker(workerRedis, deviceStore, gateway, preferenceStore, fastify.db);

  worker.on('failed', (job, err) => {
    fastify.log.error({ jobId: job?.id, err }, 'notification job failed');
  });

  fastify.decorate('enqueueNotification', async (job: NotificationJob) => {
    await enqueueNotification(queue, job, gateway, deviceStore);
  });

  fastify.addHook('onClose', async () => {
    // Teardown order matters. These used to run concurrently in one
    // Promise.allSettled, letting connection.quit() race worker/queue.close():
    // BullMQ would still issue commands on an already-quitting connection and
    // ioredis's retry/reconnect timers stayed ref'd for several seconds after
    // onClose resolved (jest then warned it "did not exit"). Close the worker
    // first (interrupts its blocking loop and stops its internal timers), then
    // the queue, and only quit the underlying connections once both are done.
    try {
      await worker.close();
    } catch (err) {
      fastify.log.error({ err }, 'notification worker close error');
    }
    try {
      await queue.close();
    } catch (err) {
      fastify.log.error({ err }, 'notification queue close error');
    }
    await Promise.allSettled([queueRedis.quit(), workerRedis.quit()]);
  });
}

export default fp(notificationsPlugin, {
  name: 'notifications',
  dependencies: ['db'],
});
