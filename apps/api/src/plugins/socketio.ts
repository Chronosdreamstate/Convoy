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

/**
 * Who is this handshake, and may it claim the group it names?
 *
 * Extracted from the `io.use` middleware so the rule is testable on its own —
 * it is the only authorization the socket ever performs against the claimed
 * group, so a silent regression here has no second line of defence.
 *
 * Returns null for "reject the connection"; throws nothing on a bad token
 * (jwt.verify's throw is caught here and reported as a rejection).
 */
export async function authorizeHandshake(
  db: Pick<FastifyInstance['db'], 'query'>,
  token: string | undefined,
  claimedGroupId: string | undefined,
): Promise<{ userId: string; groupId: string } | null> {
  if (!token) return null;

  let userId: string;
  try {
    userId = (jwt.verify(token, env.JWT_SECRET) as { sub: string }).sub;
  } catch {
    return null;
  }
  if (!userId) return null;

  const groupId = claimedGroupId ?? '';
  if (!groupId) return { userId, groupId: '' };

  // The user must be an active member of the claimed group, AND the group must
  // be a convoy rather than a DM thread. DM threads are convoy_groups rows with
  // real convoy_members entries, so a membership check on its own accepts a
  // client-supplied DM id as an "active convoy" — which is what turned a DM
  // into a live location feed for the other participant. socket.handler.ts
  // carries the same filter on its fallback lookup; this is the other way in.
  const memberResult = await db.query<{ id: string }>(
    `SELECT cm.id FROM convoy_members cm
     JOIN convoy_groups g ON g.id = cm.group_id
     WHERE cm.group_id = $1 AND cm.user_id = $2 AND cm.left_at IS NULL
       AND g.type <> 'dm'`,
    [groupId, userId],
  );
  if (memberResult.rows.length === 0) return null;

  return { userId, groupId };
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
    try {
      const identity = await authorizeHandshake(
        fastify.db,
        socket.handshake.auth.token as string | undefined,
        socket.handshake.auth.groupId as string | undefined,
      );
      if (!identity) return next(new Error('Unauthorized'));
      socket.data.userId = identity.userId;
      socket.data.groupId = identity.groupId;
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
