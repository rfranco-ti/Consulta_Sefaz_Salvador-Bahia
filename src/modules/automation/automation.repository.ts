import type { TipoAutomacao } from '../../automations/registry.js';
import { InternalError, NotFoundError } from '../../shared/errors/index.js';
import type { ExecucaoResposta } from './automation.types.js';

export interface ExecucaoRegistro {
  id: string;
  tipo: TipoAutomacao;
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  ticket: number;
  payload: string;
  attempts: number;
  apiKeyId: string;
  criadoEm: string;
  iniciadoEm?: string | null;
  finalizadoEm?: string | null;
  duracaoMs?: number | null;
}

export class AutomationRepository {
  async criar(_registro: ExecucaoRegistro): Promise<void> {
    throw new InternalError('AutomationRepository.criar nao implementado (Fase 3)');
  }

  async porId(_id: string): Promise<ExecucaoRegistro> {
    throw new InternalError('AutomationRepository.porId nao implementado (Fase 3)');
  }

  async adicionarParticipante(
    _execucaoId: string,
    _apiKeyId: string,
  ): Promise<void> {
    throw new InternalError(
      'AutomationRepository.adicionarParticipante nao implementado (Fase 3)',
    );
  }

  async historico(_apiKeyId: string): Promise<ExecucaoResposta[]> {
    throw new NotFoundError('Historico nao implementado (Fase 3)');
  }
}
