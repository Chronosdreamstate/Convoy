/**
 * Property P125: photoUrl is required — empty string is rejected (400)
 * Property P126: Caption over 280 chars is rejected (400)
 * Property P127: GET /groups/:id/photos always returns items sorted DESC by created_at
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import fastifySensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import fc from 'fast-check';
import { Pool } from 'pg';
import photosRoutes from './photos.routes';
import { authenticate } from '../middleware/authenticate';

// ---------------------------------------------------------------------------
// In-memory photo store
// ---------------------------------------------------------------------------
interface InMemoryPhoto {
  id: string;
  group_id: string;
  user_id: string;
  photo_url: string;
  caption: string | null;
  created_at: Date;
}

let photos: InMemoryPhoto[] = [];
let seqId = 0;
function nextId() { return `00000000-0000-0000-0002-${String(++seqId).padStart(12, '0')}`; }
function resetPhotos() { photos = []; seqId = 0; }

// ---------------------------------------------------------------------------
// Mock pool
// ---------------------------------------------------------------------------
function makePool(userId: string): Pool {
  return {
    query: async (sql: string, values?: unknown[]) => {
      const norm = sql.replace(/\s+/g, ' ').trim().toUpperCase();

      if (norm.startsWith('INSERT INTO GROUP_PHOTOS')) {
        const [groupId, uid, photoUrl, caption] = values as [string, string, string, string | null];
        const photo: InMemoryPhoto = {
          id: nextId(),
          group_id: groupId,
          user_id: uid,
          photo_url: photoUrl,
          caption: caption ?? null,
          created_at: new Date(),
        };
        photos.push(photo);
        return { rows: [{ id: photo.id, photo_url: photo.photo_url, caption: photo.caption, created_at: photo.created_at.toISOString() }], rowCount: 1 };
      }

      if (norm.includes('FROM GROUP_PHOTOS')) {
        const groupId = values![0] as string;
        const sorted = photos
          .filter((p) => p.group_id === groupId)
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
          .slice(0, 50);
        return {
          rows: sorted.map((p) => ({
            id: p.id,
            user_id: p.user_id,
            display_name: 'Test Rider',
            photo_url: p.photo_url,
            caption: p.caption,
            created_at: p.created_at.toISOString(),
          })),
          rowCount: sorted.length,
        };
      }

      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------
function buildApp(userId = 'user-test-1'): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(fastifyCookie);
  app.register(fastifyJwt, { secret: 'test-secret-that-is-at-least-32-chars-long!!' });
  app.register(fastifySensible);

  const pool = makePool(userId);

  app.register(fp(async (instance) => { instance.decorate('db', pool); }), { name: 'db' });
  app.register(fp(async (instance) => {
    instance.addHook('preHandler', async (req) => {
      (req as unknown as { user: { id: string } }).user = { id: userId };
    });
  }));

  app.register(photosRoutes, { pool } as { pool: Pool });

  return app;
}

// ---------------------------------------------------------------------------
// P125: photoUrl required — empty string rejected
// ---------------------------------------------------------------------------
describe('Property P125: photoUrl is required', () => {
  beforeEach(resetPhotos);

  it('empty photoUrl returns 400', async () => {
    const app = buildApp();
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/groups/group-1/photos',
      payload: { photoUrl: '' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('any valid URL is accepted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.webUrl({ withQueryParameters: false }).filter((u) => u.length > 0),
        async (url) => {
          resetPhotos();
          const app = buildApp();
          await app.ready();

          const res = await app.inject({
            method: 'POST',
            url: '/api/v1/groups/group-1/photos',
            payload: { photoUrl: url },
          });

          expect(res.statusCode).toBe(201);
          await app.close();
        },
      ),
      { numRuns: 10 },
    );
  });
});

// ---------------------------------------------------------------------------
// P126: Caption over 280 chars is rejected
// ---------------------------------------------------------------------------
describe('Property P126: Caption max 280 chars', () => {
  beforeEach(resetPhotos);

  it('caption of exactly 280 chars is accepted', async () => {
    const app = buildApp();
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/groups/group-1/photos',
      payload: { photoUrl: 'https://example.com/photo.jpg', caption: 'x'.repeat(280) },
    });

    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('caption of 281+ chars is rejected with 400', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 281, max: 1000 }),
        async (len) => {
          resetPhotos();
          const app = buildApp();
          await app.ready();

          const res = await app.inject({
            method: 'POST',
            url: '/api/v1/groups/group-1/photos',
            payload: { photoUrl: 'https://example.com/photo.jpg', caption: 'x'.repeat(len) },
          });

          expect(res.statusCode).toBe(400);
          await app.close();
        },
      ),
      { numRuns: 10 },
    );
  });
});

// ---------------------------------------------------------------------------
// P127: GET /photos returns photos in descending created_at order
// ---------------------------------------------------------------------------
describe('Property P127: Photos sorted DESC by created_at', () => {
  it('inserts with varying timestamps always come back newest-first', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 2, maxLength: 8 }),
        async (offsets) => {
          resetPhotos();

          // Manually insert photos with different created_at values
          const now = Date.now();
          for (const offset of offsets) {
            photos.push({
              id: nextId(),
              group_id: 'grp-1',
              user_id: 'user-1',
              photo_url: `https://example.com/${offset}.jpg`,
              caption: null,
              created_at: new Date(now - offset * 1000),
            });
          }

          const app = buildApp();
          await app.ready();

          const res = await app.inject({ method: 'GET', url: '/api/v1/groups/grp-1/photos' });
          expect(res.statusCode).toBe(200);

          const body = JSON.parse(res.body) as { photos: { createdAt: string }[] };
          const timestamps = body.photos.map((p) => new Date(p.createdAt).getTime());

          for (let i = 1; i < timestamps.length; i++) {
            expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i]);
          }

          await app.close();
        },
      ),
      { numRuns: 15 },
    );
  });
});
