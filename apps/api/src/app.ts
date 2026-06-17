import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import sensible from '@fastify/sensible';
import { env } from './config/env';
import dbPlugin from './plugins/db';
import redisPlugin from './plugins/redis';
import authRoutes from './auth/auth.routes';
import usersRoutes from './users/users.routes';
import settingsRoutes from './settings/settings.routes';
import vehiclesRoutes from './vehicles/vehicles.routes';
import friendsRoutes from './friends/friends.routes';
import groupsRoutes from './groups/groups.routes';
import routesRoutes from './routes/routes.routes';
import hazardsRoutes from './hazards/hazards.routes';
import pttRoutes from './ptt/ptt.routes';
import rallyRoutes from './rally/rally.routes';
import drivesRoutes from './drives/drives.routes';
import fuelRoutes from './fuel/fuel.routes';
import accountRoutes from './account/account.routes';
import placesRoutes from './places/places.routes';
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

  // WebSocket server (socket.io, must be last so db/redis decorators are available)
  await app.register(socketioPlugin);

  // Health check
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  return app;
}
