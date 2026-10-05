import { InternalError } from '../../shared/errors/index.js';
import type { JobFila } from './job.types.js';

/**
 * Fila persistida (tabela `execucoes` com status PENDING).
 * Reinicio da API nao perdem jobs pendentes (.docs/JOBS.md).
 *
 * TODO(Fase 3): implementar.
 */
export class JobRepository {
  /** Enfileira e devolve o ticket sequencial (FIFO estrito). */
  async enfileirar(_job: Omit<JobFila, 'ticket'>): Promise<number> {
    throw new InternalError('JobRepository.enfileirar nao implementado (Fase 3)');
  }

  /** Proximo PENDING em ordem de ticket, ja reservado (UPDATE atomico). */
  async proximo(): Promise<JobFila | null> {
    throw new InternalError('JobRepository.proximo nao implementado (Fase 3)');
  }

  async posicao(_id: string): Promise<number | null> {
    throw new InternalError('JobRepository.posicao nao implementado (Fase 3)');
  }

  /** Ao subir: reapresenta pendentes; marca FAILED as que estavam RUNNING. */
  async recuperarAposReinicio(): Promise<{ pendentes: number; interrompidas: number }> {
    throw new InternalError('JobRepository.recuperarAposReinicio nao implementado (Fase 3)');
  }
}
