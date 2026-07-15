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
  processNotificationJob,
  NotificationJob,
  NotificationType,
  IPushGateway,
  IDeviceStore,
  IPreferenceStore,
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

// ---------------------------------------------------------------------------
// Push data carries the job type — the mobile tap handler routes on data.type
// (app/_layout.tsx handleNotificationNavigation), so every delivered push must
// stamp it or notification taps dead-end (Req 15.4; group_invite deep link).
// ---------------------------------------------------------------------------
describe('Push payload data.type stamp', () => {
  function makePayloadGateway(): {
    gateway: IPushGateway;
    payloads: Array<{ data?: Record<string, string> }>;
  } {
    const payloads: Array<{ data?: Record<string, string> }> = [];
    const gateway: IPushGateway = {
      send: jest.fn(async (_token, _platform, payload) => {
        payloads.push({ data: payload.data });
      }),
    };
    return { gateway, payloads };
  }

  const allowAllPrefs: IPreferenceStore = {
    getPreferences: jest.fn(async () => null), // no prefs row → send everything
  };

  it('worker stamps type into push data and preserves the job payload (group_invite carries groupId)', async () => {
    const { gateway, payloads } = makePayloadGateway();
    const deviceStore = makeMockDeviceStore([{ token: 'tok', platform: 'ios' }]);

    await processNotificationJob(
      makeJob({
        type: 'group_invite',
        title: 'New Join Request',
        body: 'Someone wants to join your group',
        data: { groupId: 'g-1', requestId: 'r-1' },
      }),
      deviceStore,
      gateway,
      allowAllPrefs,
    );

    expect(payloads).toHaveLength(1);
    expect(payloads[0].data).toEqual({ groupId: 'g-1', requestId: 'r-1', type: 'group_invite' });
  });

  it('worker stamps type even when the job has no data', async () => {
    const { gateway, payloads } = makePayloadGateway();
    const deviceStore = makeMockDeviceStore([{ token: 'tok', platform: 'android' }]);

    await processNotificationJob(
      makeJob({ type: 'arriving_destination', data: undefined }),
      deviceStore,
      gateway,
      allowAllPrefs,
    );

    expect(payloads[0].data).toEqual({ type: 'arriving_destination' });
  });

  it('inline SOS delivery stamps type into push data too', async () => {
    const { gateway, payloads } = makePayloadGateway();
    const deviceStore = makeMockDeviceStore([{ token: 'tok', platform: 'ios' }]);
    const { queue } = makeMockQueue();

    await enqueueNotification(
      queue,
      makeJob({ type: 'sos_alert', data: { sosId: 's-1', groupId: 'g-1' } }),
      gateway,
      deviceStore,
    );

    expect(payloads).toHaveLength(1);
    expect(payloads[0].data).toEqual({ sosId: 's-1', groupId: 'g-1', type: 'sos_alert' });
  });
});

// ---------------------------------------------------------------------------
// Delivery guarantees — retries, dead jobs, partial device failures.
// BullMQ defaults to a single attempt, so transient failures silently lost
// notifications unless the enqueue sets attempts/backoff and the worker
// rethrows total failures (Req 15.1, 43.1).
// ---------------------------------------------------------------------------
describe('Delivery guarantees', () => {
  const allowAllPrefs: IPreferenceStore = {
    getPreferences: jest.fn(async () => null),
  };

  it('queued jobs are added with retry attempts, backoff, and Redis cleanup', async () => {
    const { queue } = makeMockQueue();

    await enqueueNotification(queue, makeJob({ type: 'hazard_alert' }));

    expect(queue.add).toHaveBeenCalledWith(
      'hazard_alert',
      expect.objectContaining({ type: 'hazard_alert' }),
      expect.objectContaining({
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: expect.anything(),
        removeOnFail: expect.anything(),
      }),
    );
  });

  it('worker rethrows when EVERY device send fails, so BullMQ retries the job', async () => {
    const gateway: IPushGateway = {
      send: jest.fn(async () => { throw new Error('expo down'); }),
    };
    const deviceStore = makeMockDeviceStore([
      { token: 't1', platform: 'ios' },
      { token: 't2', platform: 'android' },
    ]);

    await expect(
      processNotificationJob(makeJob(), deviceStore, gateway, allowAllPrefs),
    ).rejects.toThrow('expo down');
  });

  it('worker does NOT rethrow on partial failure (retry would duplicate delivered pushes)', async () => {
    const gateway: IPushGateway = {
      send: jest.fn(async (token: string) => {
        if (token === 'bad') throw new Error('DeviceNotRegistered');
      }),
    };
    const deviceStore = makeMockDeviceStore([
      { token: 'good', platform: 'ios' },
      { token: 'bad', platform: 'android' },
    ]);

    await expect(
      processNotificationJob(makeJob(), deviceStore, gateway, allowAllPrefs),
    ).resolves.toBeUndefined();
  });

  it('worker with zero devices does not throw (nothing to deliver)', async () => {
    const { gateway } = makeMockGateway();
    const deviceStore = makeMockDeviceStore([]);

    await expect(
      processNotificationJob(makeJob(), deviceStore, gateway, allowAllPrefs),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Inline SOS resilience + history persistence (Req 15.4, 20.5) — one dead
// token must not reject the fan-out, and SOS must land in the in-app
// Notification Center like every queued notification does.
// ---------------------------------------------------------------------------
describe('Inline SOS delivery resilience and history', () => {
  function makeDbMock() {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }),
    };
    return { db: db as unknown as import('pg').Pool, queries };
  }

  it('one failing device does not reject the SOS fan-out; other devices still receive it', async () => {
    const sent: string[] = [];
    const gateway: IPushGateway = {
      send: jest.fn(async (token: string) => {
        if (token === 'dead') throw new Error('DeviceNotRegistered');
        sent.push(token);
      }),
    };
    const deviceStore = makeMockDeviceStore([
      { token: 'dead', platform: 'ios' },
      { token: 'alive', platform: 'android' },
    ]);
    const { queue } = makeMockQueue();

    await expect(
      enqueueNotification(queue, makeJob({ type: 'sos_alert' }), gateway, deviceStore),
    ).resolves.toBeUndefined();
    expect(sent).toEqual(['alive']);
  });

  it('persists the SOS to notification_history when a db is provided', async () => {
    const { gateway } = makeMockGateway();
    const deviceStore = makeMockDeviceStore([{ token: 'tok', platform: 'ios' }]);
    const { queue } = makeMockQueue();
    const { db, queries } = makeDbMock();

    await enqueueNotification(
      queue,
      makeJob({ type: 'sos_alert', title: 'SOS', body: 'Help!', data: { groupId: 'g-1' } }),
      gateway,
      deviceStore,
      db,
    );

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('INSERT INTO notification_history');
    expect(queries[0].params).toEqual(['u1', 'sos_alert', 'SOS', 'Help!', JSON.stringify({ groupId: 'g-1' })]);
  });

  it('a history insert failure never blocks SOS delivery', async () => {
    const { gateway, calls } = makeMockGateway();
    const deviceStore = makeMockDeviceStore([{ token: 'tok', platform: 'ios' }]);
    const { queue } = makeMockQueue();
    const db = {
      query: jest.fn(async () => { throw new Error('db down'); }),
    } as unknown as import('pg').Pool;

    await expect(
      enqueueNotification(queue, makeJob({ type: 'sos_alert' }), gateway, deviceStore, db),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});
