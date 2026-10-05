import Fastify, { type FastifyInstance } from 'fastify';
import { env } from '../config/env.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    bodyLimit: 32 * 1024,
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async () => ({ status: 'ready' }));

  return app;
}
