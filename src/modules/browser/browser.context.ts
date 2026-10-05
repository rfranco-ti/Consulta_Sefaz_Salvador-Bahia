import { InternalError } from '../../shared/errors/index.js';
import type {
  BrowserSession,
  BrowserSessionOptions,
} from './browser.types.js';

export class BrowserContextService {
  async criarSessao(_opts: BrowserSessionOptions = {}): Promise<BrowserSession> {
    throw new InternalError(
      'BrowserContextService.criarSessao nao implementado (Fase 2)',
    );
  }
}
