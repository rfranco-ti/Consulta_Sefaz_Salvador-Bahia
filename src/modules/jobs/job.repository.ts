import { InternalError } from '../../shared/errors/index.js';
import type { JobFila } from './job.types.js';

export class JobRepository {
  async enfileirar(_job: Omit<JobFila, 'ticket'>): Promise<number> {
    throw new InternalError('JobRepository.enfileirar nao implementado (Fase 3)');
  }

  async proximo(): Promise<JobFila | null> {
    throw new InternalError('JobRepository.proximo nao implementado (Fase 3)');
  }

  async posicao(_id: string): Promise<number | null> {
    throw new InternalError('JobRepository.posicao nao implementado (Fase 3)');
  }

  async recuperarAposReinicio(): Promise<{ pendentes: number; interrompidas: number }> {
    throw new InternalError('JobRepository.recuperarAposReinicio nao implementado (Fase 3)');
  }
}
