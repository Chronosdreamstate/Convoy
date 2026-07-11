import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { createRedisClient } from './redis';
import {
  createGroupExpiryQueue,
  createGroupExpiryWorker,
  scheduleGroupExpirySweep,
  unscheduleGroupExpirySweep,
  sweepExpiredGroupJoinCodes,
  ExpiredGroupSummary,
} from '../groups/group-expiry.worker';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Runs the group-expiry sweep immediately, bypassing the hourly
     * schedule. Used by ops tooling and tests to verify Req 38.1 without
     * waiting for the repeatable job to fire.
     */
    runGroupExpirySweep(): Promise<ExpiredGroupSummary[]>;
  }
}

async function groupExpiryPlugin(fastify: FastifyInstance): Promise<void> {
  // BullMQ worker blocks its Redis connection with BLPOP — use dedicated connections.
  // BullMQ requires maxRetriesPerRequest: null on the worker's connection.
  const queueRedis = createRedisClient();
  const workerRedis = createRedisClient(undefined, null);

  const queue = createGroupExpiryQueue(queueRedis);
  const worker = createGroupExpiryWorker(workerRedis, fastify.db);

  worker.on('failed', (job, err) => {
    fastify.log.error({ jobId: job?.id, err }, 'group expiry sweep job failed');
  });
  worker.on('completed', (job, result) => {
    fastify.log.info({ jobId: job.id, result }, 'group expiry sweep completed');
  });

  // Register the hourly repeatable schedule (Req 38.1 — 24h inactivity check).
  await scheduleGroupExpirySweep(queue);

  fastify.decorate('runGroupExpirySweep', async () => sweepExpiredGroupJoinCodes(fastify.db));

  fastify.addHook('onClose', async () => {
    try {
      await unscheduleGroupExpirySweep(queue);
    } catch (err) {
      fastify.log.error({ err }, 'failed to remove group-expiry repeatable job registration');
    }
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
      fastify.log.error({ err }, 'group-expiry worker close error');
    }
    try {
      await queue.close();
    } catch (err) {
      fastify.log.error({ err }, 'group-expiry queue close error');
    }
    await Promise.allSettled([queueRedis.quit(), workerRedis.quit()]);
  });
}

export default fp(groupExpiryPlugin, {
  name: 'group-expiry',
  dependencies: ['db'],
});
