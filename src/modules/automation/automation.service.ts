import type { TipoAutomacao } from '../../automations/registry.js';
import { InternalError } from '../../shared/errors/index.js';
import type {
  ExecucaoResposta,
  IniciarExecucaoInput,
} from './automation.types.js';

/**
 * Casos de uso das automacoes (.docs/ARCHITECTURE.md — Application Layer).
 *
 * Responsabilidades:
 * - cache-first (hit responde sem fila)
 * - single-flight (execucoes identicas compartilham a mesma promessa;
 *   `artefatos` fica FORA da chave — gera a uniao do que foi pedido)
 * - delegar a criacao/dispatch para modules/jobs
 * - tratar artefatos (so gerados se pedidos, por ultimo)
 *
 * TODO(Fase 3): implementar cache + single-flight + fila.
 */
export class AutomationService {
  /** Cria (ou reaproveita) uma execucao. Sempre assincrono por padrao. */
  async iniciar(_input: IniciarExecucaoInput): Promise<ExecucaoResposta> {
    throw new InternalError('AutomationService.iniciar nao implementado (Fase 3)');
  }

  /** Status + resultado. */
  async consultar(_id: string, _apiKeyId: string): Promise<ExecucaoResposta> {
    throw new InternalError('AutomationService.consultar nao implementado (Fase 3)');
  }

  /** Cancela se PENDING. */
  async cancelar(_id: string, _apiKeyId: string): Promise<void> {
    throw new InternalError('AutomationService.cancelar nao implementado (Fase 3)');
  }

  /** Chamado pelo worker apos o robot terminar. */
  async finalizar(
    _tipo: TipoAutomacao,
    _resultado: unknown,
  ): Promise<void> {
    throw new InternalError('AutomationService.finalizar nao implementado (Fase 3)');
  }
}
