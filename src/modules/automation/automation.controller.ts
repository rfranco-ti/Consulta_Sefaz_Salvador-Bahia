import type { FastifyInstance } from 'fastify';
import { ehTipoAutomacao } from '../../automations/registry.js';
import { NotFoundError, ValidationError } from '../../shared/errors/index.js';

/**
 * Rotas de automacoes/execucoes (.docs/API.md).
 *
 * Contrato (Fase 6):
 *   POST /v1/automacoes/:tipo        202 { execucaoId, posicaoFila }
 *   GET  /v1/execucoes/:id           status + resultado
 *   GET  /v1/execucoes/:id/progresso SSE
 *   GET  /v1/execucoes/:id/documentos
 *   DELETE /v1/execucoes/:id         cancela (PENDING)
 *   GET  /v1/documentos/:id          download
 *
 * Handler so valida e delega para AutomationService — nenhuma automacao
 * aqui (.docs/ARCHITECTURE.md, regra inegociavel #1).
 *
 * TODO(Fase 6): registrar as rotas + auth + error handler central.
 */
export function registerAutomationRoutes(_app: FastifyInstance): void {
  // Registradas na Fase 6, apos service implementado.
  void ehTipoAutomacao;
  void ValidationError;
  void NotFoundError;
}
