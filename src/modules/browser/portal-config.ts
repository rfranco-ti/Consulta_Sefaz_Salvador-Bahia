import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotFoundError, ValidationError } from '../../shared/errors/index.js';

export interface PortalMetadata {
  nome: string;
  sigla: string;
  versao: string;
  autor: string;
  dataCriacao: string;
  dataUltimaValidacao: string;
  urlOficial: string;
  descricao: string;
}

export interface SeletorEtapa {
  css?: string;
  xpath?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  role?: string;
  fallbacks?: Array<{ tipo: string; valor: string }>;
}

export interface ConfigEtapa {
  valor?: string;
  campoRef?: string;
  limparPrimeiro?: boolean;
  digitarDevagar?: boolean;
  aguardarNavegacao?: boolean;
  aguardarTimeout?: number;
  tempo?: number;
  ateElemento?: string;
  ateRede?: 'networkidle' | 'load' | 'domcontentloaded' | 'commit';
  salvarComo?: string;
  timeout?: number;
  script?: string;
  expressao?: string;
  guardarEm?: string;
}

export interface HumanizarEtapa {
  moverMouseAntes?: boolean;
  delayAntes?: [number, number];
  delayDepois?: [number, number];
  scrollAteElemento?: boolean;
}

export interface EtapaPortal {
  id: string;
  descricao: string;
  acao:
    | 'navegar'
    | 'preencher'
    | 'clicar'
    | 'selecionar'
    | 'esperar'
    | 'capturar-download'
    | 'executar-script'
    | 'avaliar';
  seletores?: SeletorEtapa;
  config?: ConfigEtapa;
  humanizar?: HumanizarEtapa;
  condicao?: {
    tipo: 'sempre' | 'se_elemento' | 'se_texto' | 'se_variavel';
    seletor?: string;
    texto?: string;
    variavel?: string;
    valorEsperado?: string;
  };
  onError?: 'abort' | 'pular' | 'reload' | 'tentarFallback';
}

export interface CampoExtracao {
  descricao: string;
  obrigatorio?: boolean;
  tipo: 'texto' | 'numero' | 'data' | 'cep' | 'cnpj' | 'email' | 'telefone';
  seletor?: {
    css?: string;
    xpath?: string;
    atributo?: 'textContent' | 'innerText' | 'value' | 'src' | 'href';
  };
  regex?: Array<{
    padrao: string;
    grupo: number;
    flags?: string;
    transformar?: string;
  }>;
  fallbacks?: Array<{
    tipo: 'xpath' | 'css' | 'regex' | 'proximidade';
    label?: string;
    distanciaMax?: number;
    valor: string;
  }>;
  posProcessamento?: {
    trim?: boolean;
    removerEspacosDuplicados?: boolean;
    apenasDigitos?: boolean;
    maiusculo?: boolean;
    formatar?:
      | 'cnpj'
      | 'cpf'
      | 'cep'
      | 'telefone'
      | 'data'
      | 'inscricao_estadual';
    regexReplace?: Array<{ padrao: string; substituicao: string }>;
  };
}

export interface AcaoPosExtracao {
  acao:
    | 'screenshot'
    | 'pdf'
    | 'extrair-texto'
    | 'fechar-popup'
    | 'executar-script';
  nome?: string;
  fullPage?: boolean;
  formato?: 'A4' | 'Letter';
  margin?: string;
  salvarComo?: string;
  seletorFechar?: string;
  script?: string;
  salvarResultadoEm?: string;
}

export interface ErroEsperado {
  mensagem: string;
  acao: 'reload' | 'retry' | 'abort' | 'captcha';
  maxRetries?: number;
}

export interface PortalOcrConfig {
  prioridade: 'gemini' | 'tesseract';
  gemini?: {
    modelo: string;
    promptTemplate: string;
  };
  fallback?: {
    tesseract?: { habilitado: boolean; lang: string };
  };
}

export interface PortalHumanConfig {
  perfil?: 'rapido' | 'normal' | 'cauteloso';
}

export interface PortalCaptchaConfig {
  seletoresImagem?: string[];
  html?: {
    habilitado: boolean;
    campoOculto?: string;
    variavelJs?: string;
  };
  limiarConfiancaOcr?: number;
}

export interface PortalRecursosConfig {
  bloquearTipos?: Array<
    'font' | 'media' | 'stylesheet' | 'script' | 'xhr' | 'fetch' | 'image'
  >;
  bloquearHosts?: string[];
}

export interface PortalNavegacaoConfig {
  url: string;
  timeout: number;
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  headers?: Record<string, string>;
  cookies?: Array<{ name: string; value: string; domain: string }>;
}

export interface PortalConfig {
  metadata: PortalMetadata;
  navegacao: PortalNavegacaoConfig;
  steps: EtapaPortal[];
  extracao: Record<string, CampoExtracao>;
  posExtracao?: AcaoPosExtracao[];
  errosEsperados?: ErroEsperado[];
  ocr?: PortalOcrConfig;
  human?: PortalHumanConfig;
  captcha?: PortalCaptchaConfig;
  recursos?: PortalRecursosConfig;
}

function diretorioPadrao(): string {
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(aqui, '..', '..', 'automations', 'sites');
}

export const DIRETORIO_PORTAIS_PADRAO: string = diretorioPadrao();

function nomeArquivoPortal(portal: string): string {
  return portal.endsWith('.portal.json') ? portal : `${portal}.portal.json`;
}

function candidatosPara(portal: string, base: string): string[] {
  const arquivo = nomeArquivoPortal(portal);
  const raiz = portal.replace(/\.portal\.json$/, '');
  return [path.join(base, arquivo), path.join(base, raiz, arquivo)];
}

function codigoErroSistema(erro: unknown): string | null {
  if (typeof erro !== 'object' || erro === null) return null;
  if (!('code' in erro)) return null;
  const codigo: unknown = (erro as { code?: unknown }).code;
  return typeof codigo === 'string' ? codigo : null;
}

function ehMetadata(valor: unknown): valor is PortalMetadata {
  if (typeof valor !== 'object' || valor === null) return false;
  const sigla: unknown = (valor as { sigla?: unknown }).sigla;
  return typeof sigla === 'string' && sigla.length > 0;
}

function ehNavegacao(valor: unknown): valor is PortalNavegacaoConfig {
  if (typeof valor !== 'object' || valor === null) return false;
  const registro = valor as { url?: unknown; timeout?: unknown };
  return typeof registro.url === 'string' && typeof registro.timeout === 'number';
}

function ehPortalConfig(valor: unknown): valor is PortalConfig {
  if (typeof valor !== 'object' || valor === null) return false;
  const registro = valor as {
    metadata?: unknown;
    navegacao?: unknown;
    steps?: unknown;
    extracao?: unknown;
  };
  return (
    ehMetadata(registro.metadata) &&
    ehNavegacao(registro.navegacao) &&
    Array.isArray(registro.steps) &&
    typeof registro.extracao === 'object' &&
    registro.extracao !== null
  );
}

export async function carregarPortalConfig(
  portal: string,
  diretorioBase: string = DIRETORIO_PORTAIS_PADRAO,
): Promise<PortalConfig> {
  const candidatos = candidatosPara(portal, diretorioBase);
  let texto: string | null = null;
  let caminhoLido = candidatos[0] ?? nomeArquivoPortal(portal);
  for (const candidato of candidatos) {
    try {
      texto = await readFile(candidato, 'utf-8');
      caminhoLido = candidato;
      break;
    } catch (erro) {
      if (codigoErroSistema(erro) !== 'ENOENT') throw erro;
    }
  }
  if (texto === null) {
    throw new NotFoundError(`Configuração do portal "${portal}" não encontrada`);
  }
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto) as unknown;
  } catch {
    throw new ValidationError(
      `Configuração do portal "${portal}" contém JSON inválido`,
      { arquivo: caminhoLido },
    );
  }
  if (!ehPortalConfig(bruto)) {
    throw new ValidationError(
      `Configuração do portal "${portal}" inválida: campos metadata.sigla, navegacao, steps e extracao são obrigatórios`,
      { arquivo: caminhoLido },
    );
  }
  return bruto;
}
