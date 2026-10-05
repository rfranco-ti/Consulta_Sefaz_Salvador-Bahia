import { InternalError } from '../../shared/errors/index.js';
import type { Browser } from 'playwright-core';
import type { PoolSnapshot } from './browser.types.js';

export class BrowserFactory {
  async acquire(): Promise<Browser> {
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
  }
}
