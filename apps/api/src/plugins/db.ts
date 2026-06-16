import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { createPool, closePool } from '../db/pool';

declare module 'fastify' {
  interface FastifyInstance {
    db: Pool;
  }
}

async function dbPlugin(fastify: FastifyInstance) {
  const pool = createPool();

  // Verify connection on startup
  const client = await pool.connect();
  client.release();

  fastify.decorate('db', pool);

  fastify.addHook('onClose', async () => {
    await pool.end();
  });
}

export default fp(dbPlugin, {
  name: 'db',
});
