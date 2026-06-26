import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';

const vehicleBodySchema = z.object({
  year: z.number().int().min(1886).max(2100).nullable().optional(),
  make: z.string().max(100).nullable().optional(),
  model: z.string().max(100).nullable().optional(),
  color: z.string().max(50).nullable().optional(),
  photoUrl: z.string().url().nullable().optional(),
});

interface VehicleRow {
  id: string;
  user_id: string;
  year: number | null;
  make: string | null;
  model: string | null;
  color: string | null;
  photo_url: string | null;
  is_active: boolean;
  created_at: Date;
}

function toResponse(v: VehicleRow) {
  return {
    id: v.id,
    year: v.year,
    make: v.make,
    model: v.model,
    color: v.color,
    photoUrl: v.photo_url,
    isActive: v.is_active,
    createdAt: v.created_at,
  };
}

async function vehiclesRoutes(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /vehicles — list all vehicles for the authenticated user
  // -------------------------------------------------------------------------
  fastify.get('/vehicles', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const result = await fastify.db.query<VehicleRow>(
      `SELECT id, user_id, year, make, model, color, photo_url, is_active, created_at
       FROM vehicles WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    );

    return reply.send({ vehicles: result.rows.map(toResponse) });
  });

  // -------------------------------------------------------------------------
  // POST /vehicles — create a new vehicle
  // -------------------------------------------------------------------------
  fastify.post('/vehicles', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;

    const parsed = vehicleBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.errors[0].message);
    }

    const { year, make, model, color, photoUrl } = parsed.data;

    const result = await fastify.db.query<VehicleRow>(
      `INSERT INTO vehicles (user_id, year, make, model, color, photo_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id, year, make, model, color, photo_url, is_active, created_at`,
      [userId, year ?? null, make ?? null, model ?? null, color ?? null, photoUrl ?? null],
    );

    return reply.status(201).send(toResponse(result.rows[0]));
  });

  // -------------------------------------------------------------------------
  // PATCH /vehicles/:id — update a vehicle
  // -------------------------------------------------------------------------
  fastify.patch('/vehicles/:id', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };

    const parsed = vehicleBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.errors[0].message);
    }

    const { year, make, model, color, photoUrl } = parsed.data;

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (year !== undefined) { setClauses.push(`year = $${paramIdx++}`); values.push(year); }
    if (make !== undefined) { setClauses.push(`make = $${paramIdx++}`); values.push(make); }
    if (model !== undefined) { setClauses.push(`model = $${paramIdx++}`); values.push(model); }
    if (color !== undefined) { setClauses.push(`color = $${paramIdx++}`); values.push(color); }
    if (photoUrl !== undefined) { setClauses.push(`photo_url = $${paramIdx++}`); values.push(photoUrl); }

    if (setClauses.length === 0) {
      const current = await fastify.db.query<VehicleRow>(
        `SELECT id, user_id, year, make, model, color, photo_url, is_active, created_at
         FROM vehicles WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );
      if (!current.rows[0]) return reply.notFound('Vehicle not found');
      return reply.send(toResponse(current.rows[0]));
    }

    values.push(id, userId);

    const result = await fastify.db.query<VehicleRow>(
      `UPDATE vehicles SET ${setClauses.join(', ')}
       WHERE id = $${paramIdx} AND user_id = $${paramIdx + 1}
       RETURNING id, user_id, year, make, model, color, photo_url, is_active, created_at`,
      values,
    );

    if (!result.rows[0]) return reply.notFound('Vehicle not found');
    return reply.send(toResponse(result.rows[0]));
  });

  // -------------------------------------------------------------------------
  // DELETE /vehicles/:id
  // -------------------------------------------------------------------------
  fastify.delete('/vehicles/:id', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };

    const fetchResult = await fastify.db.query<{ id: string; is_active: boolean }>(
      `SELECT id, is_active FROM vehicles WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    if (!fetchResult.rows[0]) return reply.notFound('Vehicle not found');
    if (fetchResult.rows[0].is_active) {
      return reply.status(409).send({ error: 'Cannot delete the active vehicle. Activate another vehicle first.' });
    }

    await fastify.db.query(`DELETE FROM vehicles WHERE id = $1`, [id]);
    return reply.status(204).send();
  });

  // -------------------------------------------------------------------------
  // POST /vehicles/:id/activate — set one vehicle active, clear all others
  // Uses a single transaction to enforce the one-active invariant (Req 29.2)
  // -------------------------------------------------------------------------
  fastify.post('/vehicles/:id/activate', { preHandler: [authenticate, generalLimiter(fastify.redis)] }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };

    const client = await fastify.db.connect();
    try {
      await client.query('BEGIN');

      // Verify ownership
      const check = await client.query<{ id: string }>(
        `SELECT id FROM vehicles WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );
      if (!check.rows[0]) {
        await client.query('ROLLBACK');
        return reply.notFound('Vehicle not found');
      }

      // Deactivate all user's vehicles, then activate only the target
      await client.query(
        `UPDATE vehicles SET is_active = false WHERE user_id = $1`,
        [userId],
      );
      const result = await client.query<VehicleRow>(
        `UPDATE vehicles SET is_active = true WHERE id = $1
         RETURNING id, user_id, year, make, model, color, photo_url, is_active, created_at`,
        [id],
      );

      await client.query('COMMIT');
      return reply.send(toResponse(result.rows[0]));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}

export default vehiclesRoutes;

