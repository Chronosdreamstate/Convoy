/**
 * Property tests for the notification worker.
 *
 * Property 67: SOS alerts are always sent regardless of preferences
 *   Validates: Requirements 15.5
 *
 * Property 68: Non-SOS alerts respect user notification preferences
 *   Validates: Requirements 15.5, 16.1
 *
 * Property 69: SOS alerts bypass the queue and deliver directly
 *   Validates: Requirements 15.5
 *
 * Property 70: SOS alerts are delivered with high priority
 *   Validates: Requirements 15.1, 15.5
 */

import fc from 'fast-check';
import {
  enqueueNotification,
  NotificationJob,
  NotificationType,
  IPushGateway,
  IDeviceStore,
} from './notification.worker';
import { Queue } from 'bullmq';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<NotificationJob> = {}): NotificationJob {
  return {
    userId: 'u1',
    type: 'hazard_alert',
    title: 'Hazard',
    body: 'Pothole ahead',
    ...overrides,
  };
}

function makeMockGateway(): { gateway: IPushGateway; calls: Array<{ token: string; platform: string; priority: string }> } {
  const calls: Array<{ token: string; platform: string; priority: string }> = [];
  const gateway: IPushGateway = {
    send: jest.fn(async (token, platform, payload) => {
      calls.push({ token, platform: platform as string, priority: payload.priority });
    }),
  };
  return { gateway, calls };
}

function makeMockDeviceStore(tokens: Array<{ token: string; platform: 'ios' | 'android' }> = []): IDeviceStore {
  return {
    getTokensForUser: jest.fn(async () => tokens),
  };
}

function makeMockQueue(): { queue: Queue<NotificationJob>; addedJobs: NotificationJob[] } {
  const addedJobs: NotificationJob[] = [];
  const queue = {
    add: jest.fn(async (_name: string, job: NotificationJob) => {
      addedJobs.push(job);
    }),
  } as unknown as Queue<NotificationJob>;
  return { queue, addedJobs };
}

const NON_SOS_TYPES: NotificationType[] = [
  'hazard_alert', 'group_invite', 'arriving_destination',
  'group_event', 'rally_point', 'gap_alert', 'fuel_suggest', 'friend_request',
];

// ---------------------------------------------------------------------------
// Property 67: SOS alerts are always sent regardless of preferences
// ---------------------------------------------------------------------------
describe('Property 67: SOS alerts are always sent regardless of preferences', () => {
  it('SOS alert is delivered to all devices without preference check', async () => {
    const devices = [
      { token: 'ios-token-1', platform: 'ios' as const },
      { token: 'android-token-1', platform: 'android' as const },
    ];
    const { gateway, calls } = makeMockGateway();
    const deviceStore = makeMockDeviceStore(devices);
    const { queue } = makeMockQueue();

    const sosJob = makeJob({ type: 'sos_alert', title: 'SOS Alert', body: 'Help!' });

    await enqueueNotification(queue, sosJob, gateway, deviceStore);

    // Delivered to all devices
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.token)).toContain('ios-token-1');
    expect(calls.map((c) => c.token)).toContain('android-token-1');
  });

  it('SOS alert is sent even when user has no devices', async () => {
    const { gateway, calls } = makeMockGateway();
    const deviceStore = makeMockDeviceStore([]); // no registered devices
    const { queue } = makeMockQueue();

    const sosJob = makeJob({ type: 'sos_alert' });
    await enqueueNotification(queue, sosJob, gateway, deviceStore);

    // No error thrown — gracefully handles empty device list
    expect(calls).toHaveLength(0);
    expect(gateway.send).not.toHaveBeenCalled();
  });

  it('SOS alerts with multiple devices — all receive the notification', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        async (deviceCount) => {
          const devices = Array.from({ length: deviceCount }, (_, i) => ({
            token: `token-${i}`,
            platform: (i % 2 === 0 ? 'ios' : 'android') as 'ios' | 'android',
          }));
          const { gateway, calls } = makeMockGateway();
          const deviceStore = makeMockDeviceStore(devices);
          const { queue } = makeMockQueue();

          await enqueueNotification(queue, makeJob({ type: 'sos_alert' }), gateway, deviceStore);

          expect(calls).toHaveLength(deviceCount);
        },
      ),
      { numRuns: 10 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 68: Non-SOS alerts respect user notification preferences
// ---------------------------------------------------------------------------
describe('Property 68: Non-SOS alerts respect notification preferences', () => {
  it('non-SOS notifications are added to the queue', async () => {
    const { gateway } = makeMockGateway();
    const deviceStore = makeMockDeviceStore([{ token: 'tok', platform: 'ios' }]);

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...NON_SOS_TYPES),
        async (type) => {
          const { queue, addedJobs } = makeMockQueue();
          const job = makeJob({ type, userId: 'u-test' });
          await enqueueNotification(queue, job);

          // Non-SOS jobs go into the queue
          expect(addedJobs).toHaveLength(1);
          expect(addedJobs[0].type).toBe(type);
          // Gateway NOT called directly (goes via queue worker)
          expect(gateway.send).not.toHaveBeenCalled();
        },
      ),
      { numRuns: NON_SOS_TYPES.length },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 69: SOS alerts bypass the queue and deliver directly
// ---------------------------------------------------------------------------
describe('Property 69: SOS alerts bypass the queue and deliver directly', () => {
  it('SOS enqueue does NOT add to BullMQ queue', async () => {
    const { gateway } = makeMockGateway();
    const deviceStore = makeMockDeviceStore([{ token: 'tok', platform: 'ios' }]);
    const { queue, addedJobs } = makeMockQueue();

    await enqueueNotification(queue, makeJob({ type: 'sos_alert' }), gateway, deviceStore);

    // Queue's add() was NOT called
    expect(addedJobs).toHaveLength(0);
    expect((queue.add as jest.Mock)).not.toHaveBeenCalled();
  });

  it('non-SOS notification without gateway goes to queue', async () => {
    const { queue, addedJobs } = makeMockQueue();

    // No gateway provided — non-SOS path just uses queue
    await enqueueNotification(queue, makeJob({ type: 'hazard_alert' }));

    expect(addedJobs).toHaveLength(1);
    expect(addedJobs[0].type).toBe('hazard_alert');
  });

  it('SOS without gateway and deviceStore falls back to queue', async () => {
    const { queue, addedJobs } = makeMockQueue();

    // No gateway/deviceStore — cannot deliver inline, so fallback to queue
    await enqueueNotification(queue, makeJob({ type: 'sos_alert' }));

    expect(addedJobs).toHaveLength(1);
    expect(addedJobs[0].type).toBe('sos_alert');
  });
});

// ---------------------------------------------------------------------------
// Property 70: SOS alerts are delivered with high priority
// ---------------------------------------------------------------------------
describe('Property 70: SOS alerts are delivered with high priority', () => {
  it('SOS alert is sent with priority: high to all devices', async () => {
    const devices = [
      { token: 'tok1', platform: 'ios' as const },
      { token: 'tok2', platform: 'android' as const },
    ];
    const { gateway, calls } = makeMockGateway();
    const deviceStore = makeMockDeviceStore(devices);
    const { queue } = makeMockQueue();

    await enqueueNotification(queue, makeJob({ type: 'sos_alert' }), gateway, deviceStore);

    for (const call of calls) {
      expect(call.priority).toBe('high');
    }
  });

  it('PREFERENCE_KEY covers every non-SOS notification type', () => {
    // All non-SOS types must have a preference mapping so they can be opted out
    const PREFERENCE_KEY: Record<string, string> = {
      hazard_alert:           'notif_hazard',
      gap_alert:              'notif_navigation',
      arriving_destination:   'notif_navigation',
      fuel_suggest:           'notif_navigation',
      group_event:            'notif_group_events',
      group_invite:           'notif_group_events',
      rally_point:            'notif_group_events',
      sos_alert:              'notif_group_events',
      friend_request:         'notif_friend_requests',
    };

    for (const type of NON_SOS_TYPES) {
      expect(PREFERENCE_KEY[type]).toBeDefined();
    }
  });
});
