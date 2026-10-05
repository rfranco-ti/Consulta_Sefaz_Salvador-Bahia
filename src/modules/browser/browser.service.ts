import { InternalError } from '../../shared/errors/index.js';
import type { BrowserSession, BrowserSessionOptions } from './browser.types.js';

/**
 * Fachada unica do dominio de navegador para o resto da aplicacao.
 * Compose: factory (pool) + context (isolamento) + stealth.
 *
 * TODO(Fase 2): implementar unindo BrowserFactory + BrowserContextService.
 */
export class BrowserService {
  async criarSessao(_opts: BrowserSessionOptions = {}): Promise<BrowserSession> {
    throw new InternalError('BrowserService.criarSessao nao implementado (Fase 2)');
  }

  async shutdown(): Promise<void> {
    // no-op no scaffold
  }
}
