import Fastify, { type FastifyInstance } from 'fastify';
import { env } from '../config/env.js';

/**
 * Monta a aplicacao HTTP.
 *
 * Regras (.docs/ARCHITECTURE.md):
 * - handlers apenas validam e delegam para services;
 * - nenhuma automacao/Playwright roda aqui.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    bodyLimit: 32 * 1024, // 32 KB — ver API.md
  });

  // Liveness: processo vivo.
  app.get('/health', async () => ({ status: 'ok' }));

  // Readiness: dependencia critica saudavel.
  // TODO(Fase 2): checar pool de browser quando existir.
  app.get('/ready', async () => ({ status: 'ready' }));

  // TODO(Fase 6): app.register(authPlugin) + rotas de /v1

  return app;
}
