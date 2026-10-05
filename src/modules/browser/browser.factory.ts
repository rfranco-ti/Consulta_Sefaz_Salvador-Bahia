import { InternalError } from '../../shared/errors/index.js';
import type { Browser, LaunchOptions } from 'playwright';
import type { PoolSnapshot } from './browser.types.js';

/**
 * Pool de browsers (.docs/ARCHITECTURE.md — "Browser: pool e isolamento").
 *
 * - 1 Chromium quente lancado sob demanda, reutilizado
 * - acquire()/release() com contagem; reciclagem apos N execucoes ou
 *   por limite de memoria (substituicao em background)
 * - idle shutdown apos X minutos sem uso; relanca no proximo job
 * - flags de economia: --disable-dev-shm-usage, --disable-gpu,
 *   --disable-background-networking
 * - UA sanitizado em ponto unico (HeadlessChrome -> Chrome)
 * - hook `disconnected` → relancar automaticamente
 *
 * TODO(Fase 2): implementar.
 */
export class BrowserFactory {
  private readonly launchOptions: LaunchOptions = {
    headless: true,
    args: [
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-background-networking',
    ],
  };

  async acquire(): Promise<Browser> {
    void this.launchOptions;
    throw new InternalError('BrowserFactory.acquire nao implementado (Fase 2)');
  }

  async release(_browser: Browser): Promise<void> {
    throw new InternalError('BrowserFactory.release nao implementado (Fase 2)');
  }

  async forcarReciclagem(_browser: Browser): Promise<void> {
    throw new InternalError('BrowserFactory.forcarReciclagem nao implementado (Fase 2)');
  }

  async getRealUA(): Promise<string> {
    throw new InternalError('BrowserFactory.getRealUA nao implementado (Fase 2)');
  }

  snapshot(): PoolSnapshot {
    return { total: 0, ocupados: 0, criados: 0 };
  }

  async shutdown(): Promise<void> {
    // no-op no scaffold
  }
}
