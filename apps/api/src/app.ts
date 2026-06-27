import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { env } from './config/env';
import dbPlugin from './plugins/db';
import redisPlugin from './plugins/redis';
import authRoutes from './auth/auth.routes';
import usersRoutes from './users/users.routes';
import settingsRoutes from './settings/settings.routes';
import vehiclesRoutes from './vehicles/vehicles.routes';
import friendsRoutes from './friends/friends.routes';
import groupsRoutes, { registerGroupStatsRoute } from './groups/groups.routes';
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
import analyticsRoutes from './analytics/analytics.routes';
import speedCamerasRoutes from './speed-cameras/speed-cameras.routes';
import photosRoutes from './groups/photos.routes';
import socketioPlugin from './plugins/socketio';
import notificationsPlugin from './plugins/notifications';
import { healthRoutes } from './health/health.routes';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      env.NODE_ENV === 'development'
        ? { level: 'info', transport: { target: 'pino-pretty' } }
        : { level: 'info' },
    disableRequestLogging: env.NODE_ENV === 'test',
  });

  // Slow-request logger — warns when a response takes longer than 1 s
  app.addHook('onResponse', (req, reply, done) => {
    if (process.env.NODE_ENV !== 'test') {
      const ms = reply.elapsedTime;
      if (ms > 1000) {
        app.log.warn({ url: req.url, ms }, 'Slow request');
      }
    }
    done();
  });

  // API documentation â€” available at /docs in non-production environments
  if (env.NODE_ENV !== 'production') {
    await app.register(swagger, {
      openapi: {
        openapi: '3.0.0',
        info: {
          title: 'CONVOY API',
          description: 'Real-time group navigation and push-to-talk radio API for CONVOY',
          version: '1.0.0',
        },
        servers: [
          { url: 'http://localhost:3000', description: 'Development' },
        ],
        tags: [
          { name: 'auth', description: 'OTP authentication' },
          { name: 'groups', description: 'Convoy group management' },
          { name: 'drives', description: 'Drive history and replay' },
          { name: 'users', description: 'User profiles and search' },
          { name: 'notifications', description: 'Notification history' },
          { name: 'ptt', description: 'Push-to-talk channel tokens' },
          { name: 'friends', description: 'Friend system' },
          { name: 'vehicles', description: 'Garage / vehicle profiles' },
        ],
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          },
        },
        security: [{ bearerAuth: [] }],
      },
    });
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true },
      staticCSP: true,
    });
  }

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

  // Health check and metrics (no prefix — /health and /metrics are top-level)
  await app.register(healthRoutes);

  // Auth routes
  await app.register(authRoutes, { prefix: '/api/v1' });

  // User profile and device routes
  await app.register(usersRoutes, { prefix: '/api/v1' });

  // User settings routes
  await app.register(settingsRoutes, { prefix: '/api/v1' });

  // Garage â€” vehicle profiles
  await app.register(vehiclesRoutes, { prefix: '/api/v1' });

  // Friend system
  await app.register(friendsRoutes, { prefix: '/api/v1' });

  // Convoy group management
  await app.register(groupsRoutes, { prefix: '/api/v1' });
  await app.register(registerGroupStatsRoute, { prefix: '/api/v1' });

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

  // Places / geocoding (proxies OpenStreetMap Nominatim â€” no API key needed)
  await app.register(placesRoutes, { prefix: '/api/v1' });

  // Notification history (read/mark-read)
  await app.register(notificationsRoutes, { prefix: '/api/v1' });

  // Analytics event ingestion (optional auth — stores anonymousId)
  await app.register(analyticsRoutes, { prefix: '/api/v1' });

  // Group photo library
  await app.register(photosRoutes, { prefix: '/api/v1' });

  // Speed camera community reports
  await app.register(speedCamerasRoutes, { prefix: '/api/v1' });

  // WebSocket server (socket.io, must be last so db/redis decorators are available)
  await app.register(socketioPlugin);

  // Catch PostgreSQL "invalid input syntax for type uuid" (SQLSTATE 22P02) and return 400.
  // Without this, malformed UUID path params produce a 500 instead of a clean client error.
  app.setErrorHandler(async (error, _request, reply) => {
    if ((error as { code?: string }).code === '22P02') {
      return reply.status(400).send({ error: 'Invalid ID format â€” expected a UUID' });
    }
    // All other errors: re-throw so Fastify's default handler runs.
    throw error;
  });

  return app;
}

