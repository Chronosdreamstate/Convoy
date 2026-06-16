import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { Server as SocketIO } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { registerSocketHandlers } from '../socket/socket.handler';

declare module 'fastify' {
  interface FastifyInstance {
    io: SocketIO;
  }
}

async function socketioPlugin(fastify: FastifyInstance): Promise<void> {
  const io = new SocketIO(fastify.server, {
    cors: {
      origin: env.CORS_ORIGINS,
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  // Redis pub/sub adapter for horizontal scaling (skipped in test to avoid real connections)
  if (env.NODE_ENV !== 'test') {
    const pubClient = new Redis(env.REDIS_URL, { lazyConnect: false });
    const subClient = pubClient.duplicate();
    // ioredis is compatible with the adapter at runtime; ts-expect-error suppresses the type mismatch
    // @ts-expect-error — ioredis satisfies the required pub/sub interface at runtime
    io.adapter(createAdapter(pubClient, subClient));
    fastify.addHook('onClose', async () => {
      await Promise.allSettled([pubClient.quit(), subClient.quit()]);
    });
  }

  // Reject connections with invalid or missing JWT before room join (Req 8.1)
  io.use((socket, next) => {
    const token: string | undefined = socket.handshake.auth.token as string | undefined;
    if (!token) return next(new Error('Unauthorized'));
    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as { sub: string };
      socket.data.userId = payload.sub;
      socket.data.groupId = (socket.handshake.auth.groupId as string) ?? '';
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', registerSocketHandlers(fastify, io));

  fastify.decorate('io', io);

  fastify.addHook('onClose', async () => {
    await new Promise<void>((resolve) => io.close(() => resolve()));
  });
}

export default fp(socketioPlugin, {
  name: 'socketio',
  dependencies: ['db', 'redis'],
});
