import Fastify, { type FastifyInstance } from 'fastify';
import '../automations/index.js';
import { env } from '../config/env.js';
import { db, DocumentosRepository } from '../database/index.js';
import { criarAutomationService } from '../modules/automation/automation.service.js';
import { configurarErros } from './erros.js';
import { registrarAutenticacao } from './plugins/auth.js';
import { loggerOptions } from '../shared/logger/index.js';
import { registrarDocumentacao } from './plugins/documentacao.js';
import { registrarSaude } from './plugins/saude.js';
import { registrarAdminApiKeys } from './routes/admin-apikeys.js';
import { registrarConsultas } from './routes/consultas.js';
import { registrarDocumentos } from './routes/documentos.js';
import { registrarExecucoes, registrarProgresso } from './routes/execucoes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
    bodyLimit: 32 * 1024,
  });

  configurarErros(app);
  await registrarDocumentacao(app);
  registrarAutenticacao(app);
  registrarSaude(app);
  registrarAdminApiKeys(app);

  const banco = db();
  const servico = criarAutomationService({ banco });
  const documentos = new DocumentosRepository(banco);
  const armazenamento = { documentos, diretorioArmazenamento: env.STORAGE_DIR };

  registrarExecucoes(app, { servico, ...armazenamento });
  registrarDocumentos(app, { servico, ...armazenamento });
  registrarProgresso(app, { servico });
  registrarConsultas(app, { servico, ...armazenamento });

  return app;
}
