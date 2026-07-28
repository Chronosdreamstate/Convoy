import { buildApp } from './app';
import { env } from './config/env';

async function start() {
  const app = await buildApp();

  // Graceful shutdown: container orchestrators (K8s, Cloud Run, ECS) send
  // SIGTERM on deploy/scale-down. Without this the process is killed abruptly —
  // in-flight requests are dropped and Fastify's onClose hooks never run (the
  // notifications plugin's ordered BullMQ worker/queue + Redis teardown, the DB
  // pool drain). Close once, with a hard timeout so a hung close can't wedge
  // the shutdown forever.
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received — shutting down gracefully`);
    const forceExit = setTimeout(() => {
      app.log.error('graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    app.close().then(
      () => process.exit(0),
      (err) => {
        app.log.error(err);
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info(`CONVOY API listening on port ${env.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
