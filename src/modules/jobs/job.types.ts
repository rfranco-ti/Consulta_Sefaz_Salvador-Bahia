import type { TipoAutomacao } from '../../automations/registry.js';

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

export interface JobWorker {
  iniciar(): Promise<void>;
  parar(): Promise<void>;
}
