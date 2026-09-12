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
 *
 * `expMs` is the token's own expiry. The socket is authorized ONCE, at
 * connect, and nothing afterwards re-checks it — so without carrying the
 * expiry out of here, a connection opened with a 15-minute access token kept
 * full access for as long as it stayed open: days, and through a sign-out,
 * a password change or an account deletion. See scheduleTokenExpiry().
 */
export interface HandshakeIdentity {
  userId: string;
  groupId: string;
  /** Epoch ms at which the presented token expires; null if it never does. */
  expMs: number | null;
}

export async function authorizeHandshake(
  db: Pick<FastifyInstance['db'], 'query'>,
  token: string | undefined,
  claimedGroupId: string | undefined,
): Promise<HandshakeIdentity | null> {
  if (!token) return null;

  let userId: string;
  let expMs: number | null = null;
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as { sub: string; exp?: number };
    userId = payload.sub;
    expMs = typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
  if (!userId) return null;

  const groupId = claimedGroupId ?? '';
  if (!groupId) return { userId, groupId: '', expMs };

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

  return { userId, groupId, expMs };
}

/**
 * How long before a token expires the socket is asked to present a new one.
 * Long enough for a refresh round-trip on a bad connection, short enough that
 * a revoked session is not carried much past its natural life.
 */
export const TOKEN_REFRESH_LEAD_MS = 60_000;

/** Minimal socket surface used by enforceTokenExpiry — keeps it testable. */
export interface ExpiringSocket {
  data: { userId?: string; tokenExpMs?: number | null };
  emit(event: string, ...args: unknown[]): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
  disconnect(close?: boolean): unknown;
}

/**
 * Hold a socket only as long as the token that opened it.
 *
 * The handshake runs `jwt.verify` exactly once and nothing afterwards
 * re-checks it, so a connection opened with a 15-minute access token kept
 * emitting location, PTT and chat for as long as it stayed open — days — and
 * a sign-out, password change or account deletion never reached it. The
 * point of a short access token is a bounded window; this is what bounds it.
 *
 * Dropping a live socket mid-drive is its own harm, so expiry is a
 * conversation rather than a guillotine:
 *
 *   1. `auth:expiring` goes out TOKEN_REFRESH_LEAD_MS before expiry;
 *   2. the client refreshes and sends `auth:refresh` with the new token;
 *   3. a valid token for the SAME user re-arms the timer in place, so a
 *      healthy client never sees a disconnect at all;
 *   4. otherwise `auth:expired` is emitted and the socket is closed, and the
 *      client reconnects through the normal handshake.
 *
 * A token for a different user is refused outright — presenting someone
 * else's token must never move an established socket to their identity.
 */
export function enforceTokenExpiry(
  fastify: Pick<FastifyInstance, 'log'>,
  socket: ExpiringSocket,
  verify: (token: string) => { sub?: string; exp?: number } = (token) =>
    jwt.verify(token, env.JWT_SECRET) as { sub?: string; exp?: number },
  now: () => number = Date.now,
): void {
  let warnTimer: NodeJS.Timeout | undefined;
  let expireTimer: NodeJS.Timeout | undefined;

  const clearTimers = (): void => {
    if (warnTimer) clearTimeout(warnTimer);
    if (expireTimer) clearTimeout(expireTimer);
    warnTimer = undefined;
    expireTimer = undefined;
  };

  const schedule = (expMs: number | null | undefined): void => {
    clearTimers();
    // A token with no `exp` cannot be aged out. The app never issues one, but
    // treating "no expiry" as "never expires" silently would reintroduce the
    // very bug this function exists to close, so say so in the log.
    if (typeof expMs !== 'number') {
      fastify.log.warn(
        { userId: socket.data.userId },
        'socket token has no exp claim — connection is not expiry-bounded',
      );
      return;
    }

    const msLeft = expMs - now();
    warnTimer = setTimeout(
      () => socket.emit('auth:expiring', { expiresAt: expMs }),
      // A token already inside the lead window (or past it) is warned about
      // immediately rather than scheduled into the past.
      Math.max(0, msLeft - TOKEN_REFRESH_LEAD_MS),
    );
    expireTimer = setTimeout(() => {
      socket.emit('auth:expired');
      socket.disconnect(true);
    }, Math.max(0, msLeft));
    // Node keeps the process alive for pending timers; these must never hold
    // a shutdown open on their own.
    warnTimer.unref?.();
    expireTimer.unref?.();
  };

  socket.on('auth:refresh', ((data: unknown) => {
    const token = (data as { token?: string } | undefined)?.token;
    if (typeof token !== 'string') return;
    try {
      const payload = verify(token);
      if (!payload.sub || payload.sub !== socket.data.userId) return;
      socket.data.tokenExpMs = typeof payload.exp === 'number' ? payload.exp * 1000 : null;
      schedule(socket.data.tokenExpMs);
    } catch {
      // Invalid or expired token — leave the existing timers alone. The socket
      // still closes on schedule unless a good token arrives first.
    }
  }) as (...args: never[]) => void);

  socket.on('disconnect', clearTimers as (...args: never[]) => void);

  schedule(socket.data.tokenExpMs);
}

/**
 * Everything that must run for a newly connected socket.
 *
 * Separated from the plugin body so the *registration* is testable, not just
 * the functions it registers: expiry enforcement is a security control with
 * no second line of defence, and silently failing to attach it would look
 * exactly like the bug it closes.
 */
export function attachConnectionHandlers(
  io: Pick<SocketIO, 'on'>,
  fastify: FastifyInstance,
): void {
  io.on('connection', (socket) => enforceTokenExpiry(fastify, socket));
  io.on('connection', registerSocketHandlers(fastify, io as SocketIO));
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
      socket.data.tokenExpMs = identity.expMs;
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  attachConnectionHandlers(io, fastify);

  fastify.decorate('io', io);

  fastify.addHook('onClose', async () => {
    await new Promise<void>((resolve) => io.close(() => resolve()));
  });
}

export default fp(socketioPlugin, {
  name: 'socketio',
  dependencies: ['db', 'redis'],
});
