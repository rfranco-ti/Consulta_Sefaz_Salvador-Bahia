import { env } from '../../config/env.js';
import { InternalError } from '../../shared/errors/index.js';

/**
 * Semaforos de concorrencia + ordem de atendimento (.docs/JOBS.md):
 *
 * - SEMAFORO_GLOBAL: teto de execucoes RUNNING simultaneas
 * - SEMAFORO_POR_PORTAL: execucoes do mesmo portal uma por vez (FIFO)
 * - portais diferentes rodam em paralelo
 * - espera com teto: FILA_TIMEOUT_SEG → 503, execucao segue aguardando
 * - single-flight: execucoes identicas compartilham promessa
 *
 * TODO(Fase 3): implementar semaforos com fila FIFO por aquisicao
 * (ticket de chegada, sem starvation).
 */
export class JobService {
  private readonly global = env.SEMAFORO_GLOBAL;
  private readonly porPortal = env.SEMAFORO_POR_PORTAL;

  constructor() {
    void this.global;
    void this.porPortal;
  }

  /** Aguarda slot; resolve com a funcao de liberacao. */
  async adquirir(_portal: string, _timeoutSeg: number): Promise<() => void> {
    throw new InternalError('JobService.adquirir nao implementado (Fase 3)');
  }
}
