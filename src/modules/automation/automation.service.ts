import type { TipoAutomacao } from '../../automations/registry.js';
import { InternalError } from '../../shared/errors/index.js';
import type {
  ExecucaoResposta,
  IniciarExecucaoInput,
} from './automation.types.js';

export class AutomationService {
  async iniciar(_input: IniciarExecucaoInput): Promise<ExecucaoResposta> {
    throw new InternalError('AutomationService.iniciar nao implementado (Fase 3)');
  }

  async consultar(_id: string, _apiKeyId: string): Promise<ExecucaoResposta> {
    throw new InternalError('AutomationService.consultar nao implementado (Fase 3)');
  }

  async cancelar(_id: string, _apiKeyId: string): Promise<void> {
    throw new InternalError('AutomationService.cancelar nao implementado (Fase 3)');
  }

  async finalizar(
    _tipo: TipoAutomacao,
    _resultado: unknown,
  ): Promise<void> {
    throw new InternalError('AutomationService.finalizar nao implementado (Fase 3)');
  }
}
