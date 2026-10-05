import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { buildApp } from './app.js';

export async function startServer(): Promise<FastifyInstance> {
  const app = await buildApp();

  const encerrar = async (sinal: string): Promise<void> => {
    app.log.info({ sinal }, 'encerrando servidor');
    await app.close();
    process.exit(0);
  };

  process.once('SIGINT', () => void encerrar('SIGINT'));
  process.once('SIGTERM', () => void encerrar('SIGTERM'));

  await app.listen({ host: env.HOST, port: env.PORT });
  app.log.info(
    { host: env.HOST, port: env.PORT },
    'api-sefaz-ssa em execucao',
  );
  return app;
}
