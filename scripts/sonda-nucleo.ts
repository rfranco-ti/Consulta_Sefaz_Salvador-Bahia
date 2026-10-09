import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { localizarPorChave } from '../src/automations/base/seletores.js';

export const TEMPO_ESPERA_SONDA_MS = 3000;
export const SUFIXO_PORTAL = '.portal.json';

export type EsperaNavegacao = 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
export type SituacaoSeletor = 'PASS' | 'FAIL';

export interface CadeiaSonda {
  seletores: string[];
}

export interface PassoPortal {
  id: string;
  descricao: string;
  acao: string;
  chaveSeletor?: string;
}

export interface NavegacaoSonda {
  url: string;
  timeout: number;
  waitUntil: EsperaNavegacao;
}

export interface PortalSonda {
  nome: string;
  navegacao: NavegacaoSonda;
  seletores: Record<string, CadeiaSonda>;
  steps: PassoPortal[];
}

export interface AchadoSonda {
  chave: string;
  etapa: string;
  presente: boolean;
  detalhe: string;
}

export interface LinhaSonda {
  robot: string;
  seletor: string;
  situacao: SituacaoSeletor;
  detalhe: string;
}

export interface RelatorioSonda {
  texto: string;
  exitCode: 0 | 1;
}

const ACOES_FORMULARIO: readonly string[] = ['preencher', 'clicar', 'selecionar'];
const ACOES_ENCERRAMENTO: readonly string[] = [
  'esperar',
  'avaliar',
  'capturar-download',
  'executar-script',
];
const ESPERAS_VALIDAS: readonly string[] = ['load', 'domcontentloaded', 'networkidle', 'commit'];
const TEMPO_NAVEGACAO_PADRAO_MS = 30000;

function mensagemDeErro(erro: unknown): string {
  if (erro instanceof Error) {
    return erro.message;
  }
  return String(erro);
}

function codigoErroSistema(erro: unknown): string | null {
  if (typeof erro !== 'object' || erro === null) {
    return null;
  }
  if (!('code' in erro)) {
    return null;
  }
  const codigo: unknown = (erro as { code?: unknown }).code;
  return typeof codigo === 'string' ? codigo : null;
}

function ehRegistro(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function esperaValida(valor: unknown): EsperaNavegacao {
  if (typeof valor === 'string' && ESPERAS_VALIDAS.includes(valor)) {
    return valor as EsperaNavegacao;
  }
  return 'domcontentloaded';
}

function extrairCadeias(bruto: unknown): Record<string, CadeiaSonda> {
  if (!ehRegistro(bruto)) {
    throw new Error('portal sem seletores declarados');
  }
  const cadeias: Record<string, CadeiaSonda> = {};
  for (const [chave, entrada] of Object.entries(bruto)) {
    if (!ehRegistro(entrada)) {
      continue;
    }
    const lista: unknown = entrada['seletores'];
    if (!Array.isArray(lista)) {
      continue;
    }
    const validos = lista.filter((item): item is string => typeof item === 'string');
    if (validos.length > 0) {
      cadeias[chave] = { seletores: validos };
    }
  }
  return cadeias;
}

function extrairPassos(bruto: unknown): PassoPortal[] {
  if (!Array.isArray(bruto)) {
    throw new Error('portal sem passos declarados');
  }
  const passos: PassoPortal[] = [];
  for (const item of bruto) {
    if (!ehRegistro(item)) {
      continue;
    }
    const id = item['id'];
    const acao = item['acao'];
    if (typeof id !== 'string' || typeof acao !== 'string') {
      continue;
    }
    const passo: PassoPortal = {
      id,
      descricao: typeof item['descricao'] === 'string' ? item['descricao'] : id,
      acao,
    };
    if (typeof item['chaveSeletor'] === 'string') {
      passo.chaveSeletor = item['chaveSeletor'];
    }
    passos.push(passo);
  }
  return passos;
}

export async function carregarPortalSonda(caminho: string): Promise<PortalSonda> {
  let texto: string;
  try {
    texto = await readFile(caminho, 'utf-8');
  } catch (erro) {
    if (codigoErroSistema(erro) === 'ENOENT') {
      throw new Error('portal ' + caminho + ' não encontrado');
    }
    throw new Error('portal ' + caminho + ' ilegível: ' + mensagemDeErro(erro));
  }
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto) as unknown;
  } catch {
    throw new Error('portal ' + caminho + ' contém JSON inválido');
  }
  if (!ehRegistro(bruto)) {
    throw new Error('portal ' + caminho + ' com formato inesperado');
  }
  const navegacao = bruto['navegacao'];
  if (!ehRegistro(navegacao) || typeof navegacao['url'] !== 'string' || navegacao['url'] === '') {
    throw new Error('portal ' + caminho + ' sem navegação válida');
  }
  const timeout =
    typeof navegacao['timeout'] === 'number' && Number.isFinite(navegacao['timeout'])
      ? navegacao['timeout']
      : TEMPO_NAVEGACAO_PADRAO_MS;
  const base = path.basename(caminho);
  return {
    nome: base.endsWith(SUFIXO_PORTAL) ? base.slice(0, -SUFIXO_PORTAL.length) : base,
    navegacao: { url: navegacao['url'], timeout, waitUntil: esperaValida(navegacao['waitUntil']) },
    seletores: extrairCadeias(bruto['seletores']),
    steps: extrairPassos(bruto['steps']),
  };
}

export async function descobrirPortais(diretorioSites: string): Promise<string[]> {
  const caminhos: string[] = [];
  const robots = await readdir(diretorioSites, { withFileTypes: true });
  for (const robot of robots) {
    if (!robot.isDirectory()) {
      continue;
    }
    const arquivos = await readdir(path.join(diretorioSites, robot.name));
    for (const arquivo of arquivos) {
      if (arquivo.endsWith(SUFIXO_PORTAL)) {
        caminhos.push(path.join(diretorioSites, robot.name, arquivo));
      }
    }
  }
  return caminhos.sort();
}

export function chavesPreInteracao(portal: PortalSonda): string[] {
  const chaves: string[] = [];
  for (const passo of portal.steps) {
    if (ACOES_ENCERRAMENTO.includes(passo.acao)) {
      break;
    }
    if (!ACOES_FORMULARIO.includes(passo.acao)) {
      continue;
    }
    const chave = passo.chaveSeletor;
    if (chave === undefined || chave === '' || chaves.includes(chave)) {
      continue;
    }
    chaves.push(chave);
  }
  return chaves;
}

export function etapaDaChave(portal: PortalSonda, chave: string): string {
  for (const passo of portal.steps) {
    if (passo.chaveSeletor === chave) {
      return passo.id;
    }
  }
  return chave;
}

export async function verificarSeletor(
  pagina: Page,
  portal: PortalSonda,
  chave: string,
  timeoutMs: number = TEMPO_ESPERA_SONDA_MS,
): Promise<AchadoSonda> {
  const etapa = etapaDaChave(portal, chave);
  const cadeia = portal.seletores[chave];
  if (cadeia === undefined) {
    return { chave, etapa, presente: false, detalhe: 'chave ' + chave + ' sem cadeia no portal.json' };
  }
  try {
    await localizarPorChave(pagina, chave, portal.seletores, etapa, timeoutMs);
    return { chave, etapa, presente: true, detalhe: 'seletor ' + chave + ' presente no formulário inicial' };
  } catch (erro) {
    return { chave, etapa, presente: false, detalhe: mensagemDeErro(erro) };
  }
}

export async function verificarPagina(
  pagina: Page,
  portal: PortalSonda,
  chaves: readonly string[],
): Promise<AchadoSonda[]> {
  const achados: AchadoSonda[] = [];
  for (const chave of chaves) {
    achados.push(await verificarSeletor(pagina, portal, chave));
  }
  return achados;
}

export function calcularExitCodeSonda(linhas: LinhaSonda[]): 0 | 1 {
  for (const linha of linhas) {
    if (linha.situacao === 'FAIL') {
      return 1;
    }
  }
  return 0;
}

export function montarRelatorioSonda(linhas: LinhaSonda[]): RelatorioSonda {
  const cabecalho = 'ROBOT | SELETOR | RESULTADO | DETALHE';
  const corpo = linhas.map(
    (linha) => linha.robot + ' | ' + linha.seletor + ' | ' + linha.situacao + ' | ' + linha.detalhe,
  );
  const robots = new Set(linhas.map((linha) => linha.robot)).size;
  let ausentes = 0;
  for (const linha of linhas) {
    if (linha.situacao === 'FAIL') {
      ausentes += 1;
    }
  }
  const textoRobots = robots === 1 ? '1 robot sondado' : String(robots) + ' robots sondados';
  const textoSeletores =
    linhas.length === 1 ? '1 seletor verificado' : String(linhas.length) + ' seletores verificados';
  const textoAusentes = ausentes === 1 ? '1 ausente' : String(ausentes) + ' ausentes';
  const resumo = 'Resumo: ' + textoRobots + ', ' + textoSeletores + ', ' + textoAusentes;
  const texto = ['Sonda de seletores pré-interação contra portais reais', cabecalho, ...corpo, resumo].join(
    '\n',
  );
  return { texto, exitCode: calcularExitCodeSonda(linhas) };
}
