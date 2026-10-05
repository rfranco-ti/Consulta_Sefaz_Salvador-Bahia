import { InternalError } from '../../shared/errors/index.js';
import type { BrowserSession, BrowserSessionOptions } from './browser.types.js';

export class BrowserService {
  async criarSessao(_opts: BrowserSessionOptions = {}): Promise<BrowserSession> {
    throw new InternalError('BrowserService.criarSessao nao implementado (Fase 2)');
  }

  async shutdown(): Promise<void> {
  }
}
