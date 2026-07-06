/**
 * Group Expiry Worker — BullMQ repeatable job that expires stale join codes.
 * Requirement 38.1: a Convoy_Group's join code must stop working once the
 * group has been inactive for 24 hours (or the group session ends, which is
 * already enforced independently by groups.routes.ts checking
 * `status !== 'active'` in POST /groups/join and GET /groups/:id/invite-link).
 *
 * Follows the same queue/worker factory pattern as
 * notifications/notification.worker.ts.
 */

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GROUP_EXPIRY_QUEUE_NAME = 'group-expiry';
export const GROUP_EXPIRY_JOB_NAME = 'sweep';
// Stable id for the repeatable schedule so re-registering it on every server
// boot does not pile up duplicate repeat configs in Redis.
export const GROUP_EXPIRY_REPEAT_JOB_ID = 'group-expiry-sweep';
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface GroupExpirySweepJob {
  // No payload needed — the sweep always scans for `now() - 24h` at run time.
}

export interface ExpiredGroupSummary {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Core sweep logic — exported standalone so it can be invoked directly
// (manual trigger, ops scripts, tests) without going through BullMQ.
// ---------------------------------------------------------------------------

/**
 * Expires the join code (join_code_active = false) for every active group
 * whose last_activity_at is more than 24h old. Does NOT touch `status` —
 * per Req 38.1 only the join code expires; ending the group session itself
 * is a separate, admin-driven action (POST /groups/:id/end).
 */
export async function sweepExpiredGroupJoinCodes(db: Pool): Promise<ExpiredGroupSummary[]> {
  const result = await db.query<ExpiredGroupSummary>(
    `UPDATE convoy_groups
     SET join_code_active = false
     WHERE status = 'active'
       AND join_code_active = true
       AND last_activity_at < now() - interval '24 hours'
     RETURNING id, name`,
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Queue / Worker factories
// ---------------------------------------------------------------------------

export function createGroupExpiryQueue(connection: IORedis): Queue<GroupExpirySweepJob> {
  return new Queue<GroupExpirySweepJob>(GROUP_EXPIRY_QUEUE_NAME, { connection });
}

export function createGroupExpiryWorker(connection: IORedis, db: Pool): Worker<GroupExpirySweepJob> {
  return new Worker<GroupExpirySweepJob>(
    GROUP_EXPIRY_QUEUE_NAME,
    async (_job: Job<GroupExpirySweepJob>) => {
      const expired = await sweepExpiredGroupJoinCodes(db);
      return { expiredCount: expired.length, expiredGroupIds: expired.map((g) => g.id) };
    },
    { connection },
  );
}

/**
 * Registers the hourly repeatable sweep job. Idempotent — BullMQ dedupes
 * repeatable jobs sharing the same `jobId`/repeat options, so calling this
 * on every server boot does not create duplicate schedules.
 */
export async function scheduleGroupExpirySweep(queue: Queue<GroupExpirySweepJob>): Promise<void> {
  await queue.add(
    GROUP_EXPIRY_JOB_NAME,
    {},
    {
      repeat: { every: SWEEP_INTERVAL_MS },
      jobId: GROUP_EXPIRY_REPEAT_JOB_ID,
    },
  );
}

/** Removes the repeatable schedule — used on Fastify `onClose` to release it. */
export async function unscheduleGroupExpirySweep(queue: Queue<GroupExpirySweepJob>): Promise<void> {
  const repeatables = await queue.getRepeatableJobs();
  await Promise.all(
    repeatables
      .filter((r) => r.name === GROUP_EXPIRY_JOB_NAME)
      .map((r) => queue.removeRepeatableByKey(r.key)),
  );
}
