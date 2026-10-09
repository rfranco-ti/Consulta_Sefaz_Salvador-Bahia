import type { BrowserContext } from 'playwright-core';
import type { Logger } from 'pino';
import { logger as loggerPadrao } from '../../shared/logger/index.js';
import type { ArtefatosOpcao } from '../automation/automation.types.js';
import { obterFabricaCompartilhada, type BrowserFactory } from './browser.factory.js';
import { carregarPortalConfig, type PortalConfig } from './portal-config.js';
import type {
  BrowserSession,
  BrowserSessionOptions,
  LiberarOptions,
} from './browser.types.js';

interface MidiaCasada {
  matches: boolean;
}

interface ConstrutorAudioNavegador {
  prototype: {
    getChannelData(canal: number): Float32Array;
  };
}

interface JanelaNavegador {
  [propriedade: string]: unknown;
  matchMedia(consulta: string): MidiaCasada;
  AudioContext?: ConstrutorAudioNavegador;
  webkitAudioContext?: ConstrutorAudioNavegador;
  performance: {
    timing?: {
      requestStart?: number;
      navigationStart?: number;
      domContentLoadedEventStart?: number;
      domContentLoadedEventEnd?: number;
      loadEventEnd?: number;
    };
  };
}

declare const window: JanelaNavegador;

interface DocumentoNavegador {
  [propriedade: string]: unknown;
}

declare const document: DocumentoNavegador;

interface ConstrutorDocumento {
  prototype: {
    querySelector(seletor: string): unknown;
    querySelectorAll(seletor: string): unknown;
  };
}

declare const Document: ConstrutorDocumento;

interface NavegadorGlobal {
  [propriedade: string]: unknown;
  languages?: unknown;
  plugins?: unknown;
  hardwareConcurrency?: unknown;
  deviceMemory?: unknown;
  connection?: unknown;
  mediaDevices?: {
    enumerateDevices?: () => Promise<unknown>;
  };
}

declare const navigator: NavegadorGlobal;

interface ConstrutorNavegadorBase {
  prototype: {
    webdriver?: unknown;
  };
}

declare const Navigator: ConstrutorNavegadorBase;

interface DescricaoPermissao {
  name: string;
}

interface ConstrutorPermissoes {
  prototype: {
    query(descricao: DescricaoPermissao): Promise<unknown>;
  };
}

declare const Permissions: ConstrutorPermissoes;

interface TelaNavegador {
  [propriedade: string]: unknown;
  width: number;
  height: number;
}

declare const screen: TelaNavegador;

interface ContextoWebGLNavegador {
  getParameter(parametro: number): unknown;
}

declare const WebGLRenderingContext: {
  prototype: ContextoWebGLNavegador;
};

interface DadosImagemNavegador {
  data: Uint8ClampedArray;
}

interface ContextoCanvasNavegador {
  getImageData(x: number, y: number, largura: number, altura: number): DadosImagemNavegador;
  putImageData(dados: DadosImagemNavegador, x: number, y: number): void;
}

interface ElementoCanvasNavegador {
  width: number;
  height: number;
  getContext(tipo: string): ContextoCanvasNavegador | null;
  toDataURL(...args: Array<string | number>): string;
}

declare const HTMLCanvasElement: {
  prototype: ElementoCanvasNavegador;
};

interface ConfiguracaoRTCNavegador {
  iceServers?: Array<unknown>;
}

declare const RTCPeerConnection: {
  prototype: {
    setConfiguration(configuracao: ConfiguracaoRTCNavegador): unknown;
  };
};

export const STEALTH_SCRIPT = (arg: unknown): void => {
  const parametros = (arg ?? {}) as {
    hardwareConcurrency?: unknown;
    deviceMemory?: unknown;
  };
  const concorrenciaHardware =
    typeof parametros.hardwareConcurrency === 'number'
      ? parametros.hardwareConcurrency
      : 8;
  const memoriaDispositivo =
    typeof parametros.deviceMemory === 'number' ? parametros.deviceMemory : 8;

  const descritorOriginal = Object.getOwnPropertyDescriptor(
    Navigator.prototype,
    'webdriver',
  );
  if (descritorOriginal) {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      ...descritorOriginal,
      get: () => undefined,
      configurable: true,
    });
  }

  const padraoCdc = /^cdc_/;
  for (const chave of Object.getOwnPropertyNames(window)) {
    if (padraoCdc.test(chave)) {
      try {
        delete window[chave];
      } catch {
        continue;
      }
    }
  }
  for (const chave of Object.getOwnPropertyNames(document)) {
    if (padraoCdc.test(chave)) {
      try {
        delete document[chave];
      } catch {
        continue;
      }
    }
  }

  const consultaOriginal = Document.prototype.querySelector;
  Document.prototype.querySelector = function (seletor: string): unknown {
    if (padraoCdc.test(seletor)) return null;
    return consultaOriginal.call(this, seletor);
  };
  const consultaTodosOriginal = Document.prototype.querySelectorAll;
  Document.prototype.querySelectorAll = function (seletor: string): unknown {
    if (padraoCdc.test(seletor)) return [];
    return consultaTodosOriginal.call(this, seletor);
  };

  Object.defineProperty(navigator, 'languages', {
    get: () => ['pt-BR', 'pt', 'en-US', 'en'],
    configurable: true,
  });

  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
      {
        name: 'Chrome PDF Viewer',
        filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
      },
      { name: 'Native Client', filename: 'internal-nacl-plugin' },
    ],
    configurable: true,
  });

  Object.defineProperty(navigator, 'hardwareConcurrency', {
    get: () => concorrenciaHardware,
    configurable: true,
  });

  Object.defineProperty(navigator, 'deviceMemory', {
    get: () => memoriaDispositivo,
    configurable: true,
  });

  if (!navigator.connection) {
    Object.defineProperty(navigator, 'connection', {
      get: () => ({
        effectiveType: '4g',
        rtt: 50 + Math.floor(Math.random() * 100),
        downlink: 10 + Math.random() * 20,
        saveData: false,
      }),
      configurable: true,
    });
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    Object.defineProperty(navigator, 'mediaDevices', {
      get: () => ({
        enumerateDevices: () =>
          Promise.resolve([
            {
              deviceId: 'audio1',
              kind: 'audioinput',
              label: 'Microphone',
              groupId: 'g1',
            },
            {
              deviceId: 'video1',
              kind: 'videoinput',
              label: 'Camera',
              groupId: 'g1',
            },
            {
              deviceId: 'audio2',
              kind: 'audiooutput',
              label: 'Speakers',
              groupId: 'g1',
            },
          ]),
        getUserMedia: () => Promise.reject(new Error('Not allowed')),
      }),
      configurable: true,
    });
  }

  const consultaPermissaoOriginal = Permissions.prototype.query;
  Permissions.prototype.query = function (
    descricao: DescricaoPermissao,
  ): Promise<unknown> {
    if (descricao.name === 'notifications') {
      return Promise.resolve({ state: 'granted', onchange: null });
    }
    return consultaPermissaoOriginal.call(this, descricao);
  };

  Object.defineProperties(screen, {
    availWidth: { get: () => screen.width, configurable: true },
    availHeight: {
      get: () => Math.max(screen.height - 40, 1080),
      configurable: true,
    },
    colorDepth: { get: () => 24, configurable: true },
    pixelDepth: { get: () => 24, configurable: true },
  });

  const paraSegundos = (valor: number | undefined): number =>
    valor ? valor / 1000 : 0;
  const tempos = window.performance.timing ?? {};
  const chrome = {
    runtime: {
      onMessage: { addListener: () => {} },
      onConnect: { addListener: () => {} },
      sendMessage: () => {},
    },
    loadTimes: () => ({
      requestTime: paraSegundos(tempos.requestStart),
      startLoadTime: paraSegundos(tempos.navigationStart),
      commitLoadTime: paraSegundos(tempos.domContentLoadedEventStart),
      finishDocumentLoadTime: paraSegundos(tempos.domContentLoadedEventEnd),
      finishLoadTime: paraSegundos(tempos.loadEventEnd),
      firstPaintTime: 0,
      firstPaintAfterLoadTime: 0,
      navigationType: 'other',
      wasFetchedViaSpdy: false,
      wasNpnNegotiated: false,
      npnNegotiatedProtocol: 'http/1.1',
      wasAlternateProtocolAvailable: false,
      connectionInfo: 'http/1.1',
    }),
    csi: () => ({
      startE: paraSegundos(tempos.navigationStart),
      onloadT: paraSegundos(tempos.loadEventEnd),
      pageT: 0,
      tran: 0,
    }),
    app: {
      isInstalled: false,
      InstallState: {
        DISABLED: 'disabled',
        INSTALLED: 'installed',
        NOT_INSTALLED: 'not_installed',
      },
      RunningState: {
        CANNOT_RUN: 'cannot_run',
        READY_TO_RUN: 'ready_to_run',
        RUNNING: 'running',
      },
    },
    webstore: {
      onInstallStageChanged: { addListener: () => {} },
      onDownloadProgress: { addListener: () => {} },
    },
  };
  Object.defineProperty(window, 'chrome', {
    get: () => chrome,
    configurable: true,
  });

  if (typeof WebGLRenderingContext !== 'undefined') {
    const obterParametroOriginal = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (
      parametro: number,
    ): unknown {
      const falsificados: Record<number, string> = {
        37445: 'Intel Inc.',
        37446: 'Intel Iris OpenGL Engine',
        33901: 'WebGL GLSL ES',
        33902: 'WebGL',
        7936: 'WebKit',
        7937: 'WebKit WebGL',
        7938: 'WebGL',
        7939: 'WebGL GLSL ES',
      };
      if (parametro in falsificados) return falsificados[parametro];
      return obterParametroOriginal.call(this, parametro);
    };
  }

  const construtorAudio = window.AudioContext ?? window.webkitAudioContext;
  if (construtorAudio) {
    const obterCanalOriginal = construtorAudio.prototype.getChannelData;
    construtorAudio.prototype.getChannelData = function (
      canal: number,
    ): Float32Array {
      try {
        return obterCanalOriginal.call(this, canal);
      } catch {
        return new Float32Array(128);
      }
    };
  }

  if (typeof HTMLCanvasElement !== 'undefined') {
    const paraDataURLOriginal = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (
      ...args: Array<string | number>
    ): string {
      const tela: ElementoCanvasNavegador = this;
      const contexto = tela.getContext('2d');
      if (contexto !== null && tela.width > 0 && tela.height > 0) {
        const imagem = contexto.getImageData(0, 0, tela.width, tela.height);
        const pixels = imagem.data;
        for (let i = 0; i < pixels.length; i += 100) {
          const atual = pixels[i] ?? 0;
          pixels[i] = Math.min(255, Math.max(0, atual + (Math.random() > 0.5 ? 1 : -1)));
        }
        contexto.putImageData(imagem, 0, 0);
      }
      return paraDataURLOriginal.apply(tela, args);
    };
  }

  if (typeof RTCPeerConnection !== 'undefined') {
    const definirConfiguracaoOriginal =
      RTCPeerConnection.prototype.setConfiguration;
    RTCPeerConnection.prototype.setConfiguration = function (
      configuracao: ConfiguracaoRTCNavegador,
    ): unknown {
      if (configuracao && configuracao.iceServers) configuracao.iceServers = [];
      return definirConfiguracaoOriginal.call(this, configuracao);
    };
  }

  if (typeof window.matchMedia === 'function') {
    const consultarMidiaOriginal = window.matchMedia;
    window.matchMedia = function (consulta: string): MidiaCasada {
      const resultado = consultarMidiaOriginal.call(window, consulta);
      if (consulta.includes('print')) return { ...resultado, matches: false };
      return resultado;
    };
  }
};

export interface Fingerprint {
  viewport: { width: number; height: number };
  locale: string;
  timezoneId: string;
  hardwareConcurrency: number;
  deviceMemory: number;
}

const VIEWPORTS: Array<{ width: number; height: number }> = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
];

const CONCORRENCIAS_HARDWARE = [4, 8, 16];
const MEMORIAS_DISPOSITIVO = [4, 8];

const TIPOS_VISUAIS: ReadonlySet<string> = new Set(['image', 'font']);

export interface BrowserContextServiceOptions {
  diretorioPortais?: string;
  logger?: Logger;
}

function sortear(valores: number[], padrao: number): number {
  return valores[Math.floor(Math.random() * valores.length)] ?? padrao;
}

function pedeFidelidadeVisual(artefatos: ArtefatosOpcao): boolean {
  return artefatos === 'pdf' || artefatos === 'print' || artefatos === 'ambos';
}

export class BrowserContextService {
  private indiceFingerprint = -1;
  private readonly fabrica: BrowserFactory;
  private readonly diretorioPortais: string | undefined;
  private readonly logger: Logger;

  constructor(
    fabrica: BrowserFactory = obterFabricaCompartilhada(),
    opcoes: BrowserContextServiceOptions = {},
  ) {
    this.fabrica = fabrica;
    this.diretorioPortais = opcoes.diretorioPortais;
    this.logger = (opcoes.logger ?? loggerPadrao).child({ modulo: 'browser-context' });
  }

  async criarSessao(opts: BrowserSessionOptions = {}): Promise<BrowserSession> {
    const browser = await this.fabrica.acquire();
    try {
      const config = await this.resolverConfig(opts.portal, opts.portalConfig);
      const impressao = this.proximaFingerprint();
      const agenteUsuario = await this.fabrica.getRealUA();
      const contexto = await browser.newContext({
        userAgent: agenteUsuario,
        viewport: impressao.viewport,
        locale: impressao.locale,
        timezoneId: impressao.timezoneId,
        acceptDownloads: opts.acceptDownloads ?? false,
        ...(opts.storageState ? { storageState: opts.storageState } : {}),
      });
      await this.aplicarBloqueioRecursos(contexto, config, opts.artefatos ?? 'nenhum');
      await contexto.addInitScript(STEALTH_SCRIPT, {
        hardwareConcurrency: impressao.hardwareConcurrency,
        deviceMemory: impressao.deviceMemory,
      });
      await contexto.addInitScript(
        '(() => { if (typeof globalThis.__name !== "function") { globalThis.__name = (alvo) => alvo; } })();',
      );
      const pagina = await contexto.newPage();
      return {
        browser,
        context: contexto,
        page: pagina,
        liberar: async (opcoesLiberar: LiberarOptions = {}) => {
          await this.fecharOuRegistrar('page', pagina.close());
          await this.fecharOuRegistrar('context', contexto.close());
          if (opcoesLiberar.reciclar === true) {
            await this.fecharOuRegistrar(
              'reciclagem',
              this.fabrica.forcarReciclagem(browser),
            );
          } else {
            await this.fecharOuRegistrar('pool.release', this.fabrica.release(browser));
          }
        },
      };
    } catch (erro) {
      await this.fecharOuRegistrar(
        'pool.release (criação falhou)',
        this.fabrica.release(browser),
      );
      throw erro;
    }
  }

  private proximaFingerprint(): Fingerprint {
    this.indiceFingerprint = (this.indiceFingerprint + 1) % VIEWPORTS.length;
    const viewport = VIEWPORTS[this.indiceFingerprint] ?? {
      width: 1280,
      height: 720,
    };
    return {
      viewport: { ...viewport },
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      hardwareConcurrency: sortear(CONCORRENCIAS_HARDWARE, 8),
      deviceMemory: sortear(MEMORIAS_DISPOSITIVO, 8),
    };
  }

  private async resolverConfig(
    portal: string | undefined,
    embutida: PortalConfig | undefined,
  ): Promise<PortalConfig | null> {
    if (embutida) return embutida;
    if (!portal) return null;
    try {
      return this.diretorioPortais
        ? await carregarPortalConfig(portal, this.diretorioPortais)
        : await carregarPortalConfig(portal);
    } catch {
      this.logger.warn(
        { portal },
        'Configuração do portal indisponível, seguindo sem bloqueio de recursos',
      );
      return null;
    }
  }

  private async aplicarBloqueioRecursos(
    contexto: BrowserContext,
    config: PortalConfig | null,
    artefatos: ArtefatosOpcao,
  ): Promise<void> {
    const tipos = new Set<string>(config?.recursos?.bloquearTipos ?? []);
    if (pedeFidelidadeVisual(artefatos)) {
      for (const tipo of TIPOS_VISUAIS) tipos.delete(tipo);
    }
    const hospedeiros = (config?.recursos?.bloquearHosts ?? []).map((hospedeiro) =>
      hospedeiro.toLowerCase(),
    );
    if (tipos.size === 0 && hospedeiros.length === 0) return;
    await contexto.route('**/*', (route) => {
      const requisicao = route.request();
      let hospedeiro = '';
      try {
        hospedeiro = new URL(requisicao.url()).hostname.toLowerCase();
      } catch {
        hospedeiro = '';
      }
      const bloquear =
        tipos.has(requisicao.resourceType()) ||
        hospedeiros.some(
          (bloqueado) => hospedeiro === bloqueado || hospedeiro.endsWith(`.${bloqueado}`),
        );
      if (bloquear) return route.abort();
      return route.continue();
    });
  }

  private async fecharOuRegistrar(
    alvo: string,
    operacao: Promise<unknown>,
  ): Promise<void> {
    try {
      await operacao;
    } catch (erro) {
      this.logger.warn(
        { alvo, erro: erro instanceof Error ? erro.message : String(erro) },
        'Falha ao liberar recurso da sessão',
      );
    }
  }
}
