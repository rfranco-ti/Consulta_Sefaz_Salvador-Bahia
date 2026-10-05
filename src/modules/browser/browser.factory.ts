import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import type { Logger } from 'pino';
import { logger as loggerPadrao } from '../../shared/logger/index.js';
import { BrowserError } from '../../shared/errors/index.js';
import type { PoolSnapshot } from './browser.types.js';

export const UA_FALLBACK =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

export const ARGUMENTOS_LANCAMENTO: string[] = [
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-background-networking',
  '--renderer-process-limit=2',
];

const MAX_USOS_PADRAO = 100;
const IDLE_TTL_MS_PADRAO = 15 * 60 * 1000;

export function montarUA(versao: string, plataforma: string = process.platform): string {
  const sufixo =
    plataforma === 'win32'
      ? '(Windows NT 10.0; Win64; x64)'
      : plataforma === 'darwin'
        ? '(Macintosh; Intel Mac OS X 10_15_7)'
        : plataforma === 'linux'
          ? '(X11; Linux x86_64)'
          : null;
  if (!sufixo || !/^\d+\.\d+\.\d+\.\d+$/.test(versao)) return UA_FALLBACK;
  return `Mozilla/5.0 ${sufixo} AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${versao} Safari/537.36`;
}

export interface BrowserFactoryOptions {
  maxUsosAntesReciclar?: number;
  idleTtlMs?: number;
  argumentos?: string[];
  logger?: Logger;
}

export class BrowserFactory {
  private atual: Browser | null = null;
  private lancamentoEmAndamento: Promise<Browser> | null = null;
  private readonly usosPorBrowser = new Map<Browser, number>();
  private readonly aposentados = new Set<Browser>();
  private aquisicoesDesdeReciclagem = 0;
  private criadosTotal = 0;
  private uaReal: string | null = null;
  private temporizadorOcioso: NodeJS.Timeout | null = null;
  private reciclagemEmAndamento = false;
  private encerrado = false;
  private readonly maxUsos: number;
  private readonly idleTtlMs: number;
  private readonly argumentos: string[];
  private readonly logger: Logger;

  constructor(opcoes: BrowserFactoryOptions = {}) {
    this.maxUsos = opcoes.maxUsosAntesReciclar ?? MAX_USOS_PADRAO;
    this.idleTtlMs = opcoes.idleTtlMs ?? IDLE_TTL_MS_PADRAO;
    this.argumentos = opcoes.argumentos ?? ARGUMENTOS_LANCAMENTO;
    this.logger = (opcoes.logger ?? loggerPadrao).child({ modulo: 'browser-pool' });
  }

  async acquire(): Promise<Browser> {
    if (this.encerrado) throw new BrowserError('Pool de navegadores encerrado');
    this.reagendarDesligamentoOcioso();
    const browser = await this.garantirBrowser();
    this.usosPorBrowser.set(browser, (this.usosPorBrowser.get(browser) ?? 0) + 1);
    this.aquisicoesDesdeReciclagem += 1;
    if (this.aquisicoesDesdeReciclagem >= this.maxUsos) {
      this.aquisicoesDesdeReciclagem = 0;
      void this.reciclarEmBackground();
    }
    return browser;
  }

  async release(browser: Browser): Promise<void> {
    const usos = this.usosPorBrowser.get(browser) ?? 0;
    this.usosPorBrowser.set(browser, Math.max(0, usos - 1));
    this.reagendarDesligamentoOcioso();
    if (!browser.isConnected()) {
      this.esquecerBrowser(browser);
      return;
    }
    if (this.aposentados.has(browser) && (this.usosPorBrowser.get(browser) ?? 0) === 0) {
      await this.aposentarDefinitivo(browser);
    }
  }

  async forcarReciclagem(browser: Browser): Promise<void> {
    this.aposentados.add(browser);
    if ((this.usosPorBrowser.get(browser) ?? 0) === 0) {
      await this.aposentarDefinitivo(browser);
    }
    if (this.atual === browser) this.atual = null;
  }

  async getRealUA(): Promise<string> {
    if (this.uaReal === null) this.uaReal = UA_FALLBACK;
    return this.uaReal.replace('HeadlessChrome/', 'Chrome/');
  }

  snapshot(): PoolSnapshot {
    let ocupados = 0;
    for (const usos of this.usosPorBrowser.values()) ocupados += usos;
    return {
      total: (this.atual === null ? 0 : 1) + this.aposentados.size,
      ocupados,
      criados: this.criadosTotal,
    };
  }

  async shutdown(): Promise<void> {
    this.encerrado = true;
    if (this.temporizadorOcioso !== null) {
      clearTimeout(this.temporizadorOcioso);
      this.temporizadorOcioso = null;
    }
    const vivos = new Set<Browser>();
    if (this.atual !== null) vivos.add(this.atual);
    for (const aposentado of this.aposentados) vivos.add(aposentado);
    this.atual = null;
    this.aposentados.clear();
    this.usosPorBrowser.clear();
    for (const browser of vivos) await this.fecharSilencioso(browser);
    this.logger.info('Pool de navegadores encerrado');
  }

  private async garantirBrowser(): Promise<Browser> {
    const vivo = this.atual;
    if (vivo !== null) {
      if (vivo.isConnected()) return vivo;
      this.esquecerBrowser(vivo);
    }
    if (this.lancamentoEmAndamento === null) {
      this.lancamentoEmAndamento = this.lancarBrowser();
    }
    try {
      const novo = await this.lancamentoEmAndamento;
      this.lancamentoEmAndamento = null;
      this.atual = novo;
      return novo;
    } catch (erro) {
      this.lancamentoEmAndamento = null;
      throw erro;
    }
  }

  private async lancarBrowser(): Promise<Browser> {
    let browser: Browser;
    try {
      browser = await chromium.launch({ headless: true, args: this.argumentos });
    } catch (erro) {
      throw new BrowserError('Falha ao iniciar o navegador', { cause: erro });
    }
    this.criadosTotal += 1;
    if (this.uaReal === null) this.uaReal = montarUA(browser.version());
    this.usosPorBrowser.set(browser, 0);
    browser.on('disconnected', () => {
      this.aoDesconectar(browser);
    });
    this.logger.info('Navegador iniciado');
    return browser;
  }

  private aoDesconectar(browser: Browser): void {
    if (this.atual === browser) this.atual = null;
    if (this.aposentados.delete(browser)) this.usosPorBrowser.delete(browser);
    this.logger.warn('Navegador desconectado, próximo acquire relança');
  }

  private async reciclarEmBackground(): Promise<void> {
    if (this.reciclagemEmAndamento || this.encerrado) return;
    this.reciclagemEmAndamento = true;
    try {
      const novo = await this.lancarBrowser();
      const antigo = this.atual;
      this.atual = novo;
      if (antigo !== null && antigo !== novo) {
        this.aposentados.add(antigo);
        if ((this.usosPorBrowser.get(antigo) ?? 0) === 0) {
          await this.aposentarDefinitivo(antigo);
        }
      }
      this.logger.info('Navegador reciclado em background');
    } catch (erro) {
      this.logger.warn(
        { erro: erro instanceof Error ? erro.message : String(erro) },
        'Reciclagem do navegador falhou, mantendo o atual',
      );
    } finally {
      this.reciclagemEmAndamento = false;
    }
  }

  private async aposentarDefinitivo(browser: Browser): Promise<void> {
    this.aposentados.delete(browser);
    if (this.atual === browser) this.atual = null;
    this.usosPorBrowser.delete(browser);
    await this.fecharSilencioso(browser);
  }

  private esquecerBrowser(browser: Browser): void {
    if (this.atual === browser) this.atual = null;
    this.aposentados.delete(browser);
    this.usosPorBrowser.delete(browser);
  }

  private async fecharSilencioso(browser: Browser): Promise<void> {
    try {
      await browser.close();
    } catch (erro) {
      this.logger.warn(
        { erro: erro instanceof Error ? erro.message : String(erro) },
        'Falha ao encerrar navegador',
      );
    }
  }

  private reagendarDesligamentoOcioso(): void {
    if (this.temporizadorOcioso !== null) clearTimeout(this.temporizadorOcioso);
    if (this.encerrado) return;
    this.temporizadorOcioso = setTimeout(() => {
      void this.desligarSeOcioso();
    }, this.idleTtlMs);
    this.temporizadorOcioso.unref?.();
  }

  private async desligarSeOcioso(): Promise<void> {
    this.temporizadorOcioso = null;
    if (this.encerrado) return;
    if (this.lancamentoEmAndamento !== null) {
      this.reagendarDesligamentoOcioso();
      return;
    }
    let ocupados = 0;
    for (const usos of this.usosPorBrowser.values()) ocupados += usos;
    if (ocupados > 0) {
      this.reagendarDesligamentoOcioso();
      return;
    }
    const alvo = this.atual;
    this.atual = null;
    if (alvo !== null) {
      this.usosPorBrowser.delete(alvo);
      await this.fecharSilencioso(alvo);
      this.logger.info('Navegador encerrado por ociosidade');
    }
  }
}

let fabricaCompartilhada: BrowserFactory | null = null;

export function obterFabricaCompartilhada(): BrowserFactory {
  if (fabricaCompartilhada === null) fabricaCompartilhada = new BrowserFactory();
  return fabricaCompartilhada;
}

export async function encerrarFabricaCompartilhada(): Promise<void> {
  if (fabricaCompartilhada === null) return;
  const fabrica = fabricaCompartilhada;
  fabricaCompartilhada = null;
  await fabrica.shutdown();
}
