import { InternalError } from '../../shared/errors/index.js';
import type {
  BrowserSession,
  BrowserSessionOptions,
} from './browser.types.js';

/**
 * Cria o contexto isolado da execucao (.docs/PLAYWRIGHT.md — lifecycle):
 *
 *   pool.acquire → newContext (isolado) → bloqueio de recursos (portal.json)
 *     → stealth/fingerprint → newPage
 *
 * Robots NUNCA tocam no Playwright cru — toda sessao passa por aqui.
 *
 * Bloqueio de recursos: imagens/fontes/midia bloqueadas por padrao;
 * LIBERADAS quando a execucao pede artefatos (fidelidade do PDF/print).
 *
 * TODO(Fase 2): implementar.
 */
export class BrowserContextService {
  async criarSessao(_opts: BrowserSessionOptions = {}): Promise<BrowserSession> {
    throw new InternalError(
      'BrowserContextService.criarSessao nao implementado (Fase 2)',
    );
  }
}
