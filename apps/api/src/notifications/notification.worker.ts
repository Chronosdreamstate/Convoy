/**
 * Notification Worker — BullMQ queue processor for push notifications.
 * Requirements: 15.1–15.5
 */

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';

// ---------------------------------------------------------------------------
// Job types
// ---------------------------------------------------------------------------

export type NotificationType =
  | 'hazard_alert'
  | 'group_invite'
  | 'arriving_destination'
  | 'group_event'
  | 'rally_point'
  | 'sos_alert'
  | 'gap_alert'
  | 'fuel_suggest'
  | 'friend_request';

export interface NotificationJob {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// FCM/APNs gateway (injectable stub — wire real SDK in production)
// ---------------------------------------------------------------------------

export interface IPushGateway {
  send(token: string, platform: 'ios' | 'android', payload: {
    title: string;
    body: string;
    data?: Record<string, string>;
    priority: 'normal' | 'high';
  }): Promise<void>;
}

export interface IDeviceStore {
  getTokensForUser(userId: string): Promise<Array<{ token: string; platform: 'ios' | 'android' }>>;
}

// ---------------------------------------------------------------------------
// Queue factory
// ---------------------------------------------------------------------------

export function createNotificationQueue(connection: IORedis): Queue<NotificationJob> {
  return new Queue<NotificationJob>('notifications', { connection });
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

export function createNotificationWorker(
  connection: IORedis,
  deviceStore: IDeviceStore,
  gateway: IPushGateway,
): Worker<NotificationJob> {
  return new Worker<NotificationJob>(
    'notifications',
    async (job: Job<NotificationJob>) => {
      const { userId, type, title, body, data } = job.data;
      const devices = await deviceStore.getTokensForUser(userId);

      // SOS alerts bypass any per-category checks — always high priority (Req 15.5)
      const priority: 'normal' | 'high' = type === 'sos_alert' ? 'high' : 'normal';

      await Promise.all(
        devices.map((d) =>
          gateway.send(d.token, d.platform, { title, body, data, priority }),
        ),
      );
    },
    { connection, concurrency: 20 },
  );
}

// ---------------------------------------------------------------------------
// Enqueue helper — SOS bypasses queue and sends inline (Req 15.5)
// ---------------------------------------------------------------------------

export async function enqueueNotification(
  queue: Queue<NotificationJob>,
  job: NotificationJob,
  gateway?: IPushGateway,
  deviceStore?: IDeviceStore,
): Promise<void> {
  if (job.type === 'sos_alert' && gateway && deviceStore) {
    // High-priority SOS: bypass BullMQ queue and deliver directly
    const devices = await deviceStore.getTokensForUser(job.userId);
    await Promise.all(
      devices.map((d) =>
        gateway.send(d.token, d.platform, {
          title: job.title,
          body: job.body,
          data: job.data,
          priority: 'high',
        }),
      ),
    );
    return;
  }
  await queue.add(job.type, job);
}
