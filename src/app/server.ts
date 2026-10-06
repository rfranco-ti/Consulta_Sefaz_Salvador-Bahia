import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { db, fecharDb } from '../database/index.js';
import { encerrarBrowserService } from '../modules/browser/browser.service.js';
import { iniciarWorker, pararWorker } from '../modules/jobs/index.js';
import { iniciarHigiene, pararHigiene } from '../modules/higiene/index.js';
import { registrarExtratorTextoPdf } from '../automations/base/ocr.js';
import { cadeiaExtracaoTextoPdf } from '../automations/base/ocr/extracao-pdf.js';
import { registrarResolvedorCaptcha } from '../automations/base/captcha.js';
import { resolverCaptchaLocal } from '../automations/base/captcha/resolvedor.js';
import { buildApp } from './app.js';

export async function startServer(): Promise<FastifyInstance> {
  registrarExtratorTextoPdf(cadeiaExtracaoTextoPdf);
  registrarResolvedorCaptcha(resolverCaptchaLocal);
  const app = await buildApp();
  await iniciarWorker({ banco: db(), filaTimeoutSeg: env.FILA_TIMEOUT_SEG });
  iniciarHigiene({
    banco: db(),
    diretorioArmazenamento: env.STORAGE_DIR,
    ttlDiasDocumentos: env.DOCUMENTOS_TTL_DIAS,
    intervaloMin: env.HIGIENE_INTERVALO_MIN,
  });

  const encerrar = async (sinal: string): Promise<void> => {
    app.log.info({ sinal }, 'encerrando servidor');
    try {
      await pararWorker();
      pararHigiene();
      await app.close();
      await encerrarBrowserService();
      fecharDb();
    } finally {
      process.exit(0);
    }
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
