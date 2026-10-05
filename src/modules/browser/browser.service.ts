import { BrowserContextService } from './browser.context.js';
import { BrowserFactory, obterFabricaCompartilhada } from './browser.factory.js';
import type { BrowserSession, BrowserSessionOptions } from './browser.types.js';

export class BrowserService {
  private readonly fabrica: BrowserFactory;
  private readonly sessoes: BrowserContextService;

  constructor(
    fabrica: BrowserFactory = obterFabricaCompartilhada(),
    sessoes?: BrowserContextService,
  ) {
    this.fabrica = fabrica;
    this.sessoes = sessoes ?? new BrowserContextService(fabrica);
  }

  async criarSessao(opts: BrowserSessionOptions = {}): Promise<BrowserSession> {
    return this.sessoes.criarSessao(opts);
  }

  async shutdown(): Promise<void> {
    await this.fabrica.shutdown();
  }
}

let servicoCompartilhado: BrowserService | null = null;

export function obterBrowserService(): BrowserService {
  if (servicoCompartilhado === null) {
    servicoCompartilhado = new BrowserService();
  }
  return servicoCompartilhado;
}

export async function encerrarBrowserService(): Promise<void> {
  if (servicoCompartilhado === null) return;
  const servico = servicoCompartilhado;
  servicoCompartilhado = null;
  await servico.shutdown();
}
