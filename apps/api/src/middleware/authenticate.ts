import fp from 'fastify-plugin';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Verifies the JWT on a request.
 * On failure, throws a 401 Unauthorized response.
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    throw reply.unauthorized('Authentication required');
  }
}

/**
 * Fastify plugin that decorates the instance with `fastify.authenticate`.
 */
async function authenticatePlugin(fastify: FastifyInstance): Promise<void> {
  fastify.decorate('authenticate', authenticate);
}

export default fp(authenticatePlugin, {
  name: 'authenticate',
  dependencies: ['@fastify/jwt'],
});
