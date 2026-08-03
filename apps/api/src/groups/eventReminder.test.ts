/**
 * POST /groups/:id/events/:eventId/remind
 *
 * The endpoint reported `sent: <n>` and no phone ever buzzed: it looked up the
 * attendees' push tokens and then only wrote notification_history rows, which
 * are the in-app centre's copy — nothing was ever handed to the push queue.
 * It also keyed the fan-out on devices rather than people, so a rider with two
 * devices was reminded twice and a rider with none was not reminded at all.
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { Pool } from 'pg';
import Redis from 'ioredis';
import groupsRoutes from './groups.routes';

const GROUP = '11111111-1111-4111-8111-111111111111';
const EVENT = '22222222-2222-4222-8222-222222222222';
const ORGANISER = '33333333-3333-4333-8333-333333333333';
const GOING_A = '44444444-4444-4444-8444-444444444444';
const GOING_B = '55555555-5555-4555-8555-555555555555';

interface Recorded {
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

let sqlSeen: string[] = [];
let enqueued: Recorded[] = [];
let members: string[] = [];
let goingUserIds: string[] = [];
let eventExists = true;

function buildMockPool(): Pool {
  return {
    query: async (sql: string, params?: unknown[]) => {
      sqlSeen.push(sql.replace(/\s+/g, ' ').trim());

      if (sql.includes('FROM convoy_members')) {
        const [, userId] = params as [string, string];
        return members.includes(userId)
          ? { rows: [{ '?column?': 1 }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM group_events')) {
        return eventExists
          ? {
              rows: [{ title: 'Sunday Canyon Run', scheduled_for: new Date('2026-08-09T09:00:00Z'), group_id: GROUP }],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM event_rsvps')) {
        const [, requesterId] = params as [string, string];
        const rows = goingUserIds.filter((u) => u !== requesterId).map((user_id) => ({ user_id }));
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
  } as unknown as Pool;
}

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);
  app.register(fastifyJwt, { secret: 'test-secret-that-is-at-least-32-chars-ok!', sign: { expiresIn: '15m' } });
  app.register(fastifySensible);
  app.register(fp(async (i) => { i.decorate('db', buildMockPool()); }, { name: 'db' }));
  app.register(fp(async (i) => { i.decorate('redis', {} as Redis); }, { name: 'redis' }));
  app.register(fp(async (i) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    i.decorate('io', { to: () => ({ emit: () => true }) } as any);
    i.decorate('enqueueNotification', (async (job: Recorded) => { enqueued.push(job); }) as never);
  }, { name: 'io' }));
  app.register(groupsRoutes, { prefix: '/api/v1' });
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  sqlSeen = [];
  enqueued = [];
  members = [ORGANISER, GOING_A, GOING_B];
  goingUserIds = [ORGANISER, GOING_A, GOING_B];
  eventExists = true;
  app = buildTestApp();
  await app.ready();
});

afterEach(async () => { await app.close(); });

function remind(callerId: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/groups/${GROUP}/events/${EVENT}/remind`,
    headers: { Authorization: `Bearer ${app.jwt.sign({ sub: callerId })}` },
  });
}

describe('POST /groups/:id/events/:eventId/remind', () => {
  it('queues a push for every attendee except the one who pressed the button', async () => {
    const res = await remind(ORGANISER);

    expect(res.statusCode).toBe(200);
    expect(enqueued.map((j) => j.userId).sort()).toEqual([GOING_A, GOING_B].sort());
    expect(res.json().sent).toBe(2);
  });

  it('sends through the notification queue, not straight into the history table', async () => {
    // The queue is what applies the user's preferences, fans out to their
    // devices, and writes the single history row. Writing the row directly
    // skipped delivery entirely.
    await remind(ORGANISER);

    expect(enqueued).toHaveLength(2);
    expect(sqlSeen.some((s) => s.toUpperCase().includes('INSERT INTO NOTIFICATION_HISTORY'))).toBe(false);
  });

  it('reminds each attendee once, whatever devices they own', async () => {
    // Previously keyed on push_devices rows: two devices meant two reminders.
    await remind(ORGANISER);

    const ids = enqueued.map((j) => j.userId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('carries the ids the tap handler needs to open the event', async () => {
    await remind(ORGANISER);

    expect(enqueued[0]).toMatchObject({
      type: 'event_reminder',
      title: expect.stringContaining('Sunday Canyon Run'),
      data: { groupId: GROUP, eventId: EVENT },
    });
  });

  it('refuses a caller who is not in the group', async () => {
    const outsider = '66666666-6666-4666-8666-666666666666';
    const res = await remind(outsider);

    expect(res.statusCode).toBe(403);
    expect(enqueued).toHaveLength(0);
  });

  it('404s for an event that is not upcoming', async () => {
    eventExists = false;
    const res = await remind(ORGANISER);

    expect(res.statusCode).toBe(404);
    expect(enqueued).toHaveLength(0);
  });

  it('is a no-op when nobody else said they are going', async () => {
    goingUserIds = [ORGANISER];
    const res = await remind(ORGANISER);

    expect(res.statusCode).toBe(200);
    expect(res.json().sent).toBe(0);
    expect(enqueued).toHaveLength(0);
  });
});
