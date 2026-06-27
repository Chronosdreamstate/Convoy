import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env';
import dbPlugin from './plugins/db';
import redisPlugin from './plugins/redis';
import authRoutes from './auth/auth.routes';
import usersRoutes from './users/users.routes';
import settingsRoutes from './settings/settings.routes';
import vehiclesRoutes from './vehicles/vehicles.routes';
import friendsRoutes from './friends/friends.routes';
import groupsRoutes from './groups/groups.routes';
import chatRoutes from './groups/chat.routes';
import routesRoutes from './routes/routes.routes';
import hazardsRoutes from './hazards/hazards.routes';
import pttRoutes from './ptt/ptt.routes';
import rallyRoutes from './rally/rally.routes';
import drivesRoutes from './drives/drives.routes';
import fuelRoutes from './fuel/fuel.routes';
import accountRoutes from './account/account.routes';
import placesRoutes from './places/places.routes';
import notificationsRoutes from './notifications/notifications.routes';
import socketioPlugin from './plugins/socketio';
import notificationsPlugin from './plugins/notifications';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      env.NODE_ENV === 'development'
        ? { level: 'info', transport: { target: 'pino-pretty' } }
        : { level: 'info' },
    disableRequestLogging: env.NODE_ENV === 'test',
  });

  // Security headers
  await app.register(helmet, { contentSecurityPolicy: false });

  // IP-level burst protection (200 req/min per IP globally; individual routes use
  // the Redis-backed rateLimiter middleware for per-user limits).
  // Disabled in test to avoid interfering with property test suites.
  if (env.NODE_ENV !== 'test') {
    await app.register(rateLimit, {
      global: true,
      max: 200,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.ip,
      errorResponseBuilder: (_request, context) => ({
        error: 'Too many requests',
        retryAfter: context.after,
      }),
    });
  }

  // CORS
  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    credentials: true,
  });

  // Cookie parser (must be before JWT so refresh token cookie is readable)
  await app.register(cookie);

  // JWT (access tokens)
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    cookie: {
      cookieName: 'refreshToken',
      signed: false,
    },
    sign: {
      expiresIn: env.JWT_ACCESS_TTL,
    },
  });

  // Sensible error helpers
  await app.register(sensible);

  // Database and cache plugins
  await app.register(dbPlugin);
  await app.register(redisPlugin);

  // Push notification queue and worker
  await app.register(notificationsPlugin);

  // Auth routes
  await app.register(authRoutes, { prefix: '/api/v1' });

  // User profile and device routes
  await app.register(usersRoutes, { prefix: '/api/v1' });

  // User settings routes
  await app.register(settingsRoutes, { prefix: '/api/v1' });

  // Garage — vehicle profiles
  await app.register(vehiclesRoutes, { prefix: '/api/v1' });

  // Friend system
  await app.register(friendsRoutes, { prefix: '/api/v1' });

  // Convoy group management
  await app.register(groupsRoutes, { prefix: '/api/v1' });

  // Group text chat
  await app.register(chatRoutes, { prefix: '/api/v1' });

  // Route calculation and push
  await app.register(routesRoutes, { prefix: '/api/v1' });

  // Hazard reporting
  await app.register(hazardsRoutes, { prefix: '/api/v1' });

  // PTT channel management and token endpoint
  await app.register(pttRoutes, { prefix: '/api/v1' });

  // Rally points and SOS broadcasts
  await app.register(rallyRoutes, { prefix: '/api/v1' });

  // Drive history
  await app.register(drivesRoutes, { prefix: '/api/v1' });

  // Fuel stop suggestions
  await app.register(fuelRoutes, { prefix: '/api/v1' });

  // Account management and data export
  await app.register(accountRoutes, { prefix: '/api/v1' });

  // Places / geocoding (proxies OpenStreetMap Nominatim — no API key needed)
  await app.register(placesRoutes, { prefix: '/api/v1' });

  // Notification history (read/mark-read)
  await app.register(notificationsRoutes, { prefix: '/api/v1' });

  // WebSocket server (socket.io, must be last so db/redis decorators are available)
  await app.register(socketioPlugin);

  // Catch PostgreSQL "invalid input syntax for type uuid" (SQLSTATE 22P02) and return 400.
  // Without this, malformed UUID path params produce a 500 instead of a clean client error.
  app.setErrorHandler(async (error, _request, reply) => {
    if ((error as { code?: string }).code === '22P02') {
      return reply.status(400).send({ error: 'Invalid ID format — expected a UUID' });
    }
    // All other errors: re-throw so Fastify's default handler runs.
    throw error;
  });

  // Health check — probes DB and Redis so load balancers get a real liveness signal
  app.get('/health', async (_request, reply) => {
    const checks: Record<string, 'ok' | 'error'> = {};
    let healthy = true;

    try {
      await app.db.query('SELECT 1');
      checks.db = 'ok';
    } catch {
      checks.db = 'error';
      healthy = false;
    }

    try {
      await app.redis.ping();
      checks.redis = 'ok';
    } catch {
      checks.redis = 'error';
      healthy = false;
    }

    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
    });
  });

  return app;
}
