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
    io.adapter(createAdapter(pubClient, subClient));
    fastify.addHook('onClose', async () => {
      await Promise.allSettled([pubClient.quit(), subClient.quit()]);
    });
  }

  // Reject connections with invalid or missing JWT before room join (Req 8.1)
  io.use(async (socket, next) => {
    const token: string | undefined = socket.handshake.auth.token as string | undefined;
    if (!token) return next(new Error('Unauthorized'));
    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as { sub: string };
      const userId = payload.sub;
      const groupId = (socket.handshake.auth.groupId as string) ?? '';

      // Verify the user is an active member of the claimed group
      if (groupId) {
        const memberResult = await fastify.db.query<{ id: string }>(
          `SELECT cm.id FROM convoy_members cm
           WHERE cm.group_id = $1 AND cm.user_id = $2 AND cm.left_at IS NULL`,
          [groupId, userId],
        );
        if (memberResult.rows.length === 0) {
          return next(new Error('Unauthorized'));
        }
      }

      socket.data.userId = userId;
      socket.data.groupId = groupId;
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
