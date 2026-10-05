import type { TipoAutomacao } from '../../automations/registry.js';

/**
 * Estados e registros das execucoes (.docs/JOBS.md).
 * `PENDING -> RUNNING -> SUCCESS | FAILED` (+ CANCELLED antes de iniciar).
 */
export type ExecucaoStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'CANCELLED';

export interface JobFila {
  id: string;
  tipo: TipoAutomacao;
  ticket: number;
  status: ExecucaoStatus;
  attempts: number;
  apiKeyId: string;
  criadoEm: string;
}

/**
 * Contrato do worker: consome a fila em FIFO estrito, respeitando
 * semaforo global (SEMAFORO_GLOBAL) e semaforo por portal
 * (SEMAFORO_POR_PORTAL).
 *
 * TODO(Fase 3): fila persistida em SQLite + dispatcher com tickets.
 */
export interface JobWorker {
  iniciar(): Promise<void>;
  parar(): Promise<void>;
}
