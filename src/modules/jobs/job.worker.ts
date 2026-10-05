import { InternalError } from '../../shared/errors/index.js';
import type { JobWorker } from './job.types.js';

/**
 * Worker: consome a fila e executa as automacoes.
 *
 * Responsabilidades (JOBS.md):
 * - dispatch FIFO estrito (tickets)
 * - adquirir slot (global + portal) com timeout de fila
 * - marcar RUNNING → executar robot com timeout → SUCCESS/FAILED
 * - retry APENAS para erros recuperaveis (rede/timeout), max 2, backoff+jitter
 * - erros NUNCA vao ao cache
 * - log estruturado com execucaoId/tipo/etapa/duracao
 * - desligamento: parar de aceitar, drenar RUNNING com teto
 *
 * TODO(Fase 3): implementar.
 */
export class JobWorkerImpl implements JobWorker {
  async iniciar(): Promise<void> {
    throw new InternalError('JobWorker.iniciar nao implementado (Fase 3)');
  }

  async parar(): Promise<void> {
    throw new InternalError('JobWorker.parar nao implementado (Fase 3)');
  }
}
