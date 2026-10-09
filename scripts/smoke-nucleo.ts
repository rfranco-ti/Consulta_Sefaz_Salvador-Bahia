import type { ZodError } from 'zod';
import { TIPOS_AUTOMACAO, type TipoAutomacao } from '../src/automations/registry.js';
import { schemaDoTipo } from '../src/modules/automation/automation.schemas.js';
import type { ExecucaoResposta } from '../src/modules/automation/automation.types.js';

export const ORCAMENTO_POR_ROBOT_MS = 360000;
export const INTERVALO_POLL_MS = 3000;

export type AcaoPlano = 'executar' | 'pular' | 'invalido';

export interface ItemPlano {
  tipo: TipoAutomacao;
  acao: AcaoPlano;
  variavel: string;
  payload: Record<string, unknown> | null;
  mensagem: string | null;
}

export type ResultadoSmoke = 'OK' | 'FAIL' | 'SKIP' | 'TIMEOUT';

export interface LinhaRelatorio {
  tipo: TipoAutomacao;
  resultado: ResultadoSmoke;
  duracaoMs: number | null;
  observacao: string;
}

export interface DesfechoExecucao {
  tipo: TipoAutomacao;
  status: string;
  sucesso: boolean | null;
  duracaoMs: number;
  erro: string | null;
  cacheHit?: boolean;
}

export type ValidacaoPayload =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; mensagem: string };

export interface RelatorioSmoke {
  texto: string;
  exitCode: 0 | 1;
}

const STATUS_TERMINAIS: readonly string[] = ['SUCCESS', 'FAILED', 'CANCELLED'];

export function nomeVariavelDoTipo(tipo: TipoAutomacao): string {
  return 'SMOKE_' + tipo.replace(/-/g, '_').toUpperCase();
}

export function mensagemErroZod(erro: ZodError): string {
  const partes = erro.issues.map((item) => {
    const caminho = item.path.map(String).join('.');
    return caminho === '' ? item.message : caminho + ': ' + item.message;
  });
  return partes.join('; ');
}

export function validarPayloadDoTipo(tipo: TipoAutomacao, bruto: unknown): ValidacaoPayload {
  const saida = schemaDoTipo(tipo).safeParse(bruto);
  if (!saida.success) {
    return { ok: false, mensagem: mensagemErroZod(saida.error) };
  }
  const dados: unknown = saida.data;
  if (typeof dados !== 'object' || dados === null || Array.isArray(dados)) {
    return { ok: false, mensagem: 'payload deve ser um objeto JSON' };
  }
  return { ok: true, payload: dados as Record<string, unknown> };
}

export function lerPlanoSmoke(variaveis: Record<string, string | undefined>): ItemPlano[] {
  return TIPOS_AUTOMACAO.map((tipo) => lerItemPlano(tipo, variaveis));
}

export function parsearApenas(args: readonly string[]): { tipos: TipoAutomacao[]; erro: string | null } {
  const indice = args.indexOf('--apenas');
  if (indice === -1) {
    return { tipos: [], erro: null };
  }
  const bruto = args[indice + 1];
  if (bruto === undefined || bruto.trim() === '') {
    return { tipos: [], erro: '--apenas exige ao menos um tipo após o sinalizador' };
  }
  const nomes = bruto
    .split(',')
    .map((nome) => nome.trim())
    .filter((nome) => nome !== '');
  const desconhecidos = nomes.filter((nome) => !TIPOS_AUTOMACAO.includes(nome as TipoAutomacao));
  if (desconhecidos.length > 0) {
    return { tipos: [], erro: 'tipos desconhecidos em --apenas: ' + desconhecidos.join(', ') };
  }
  return { tipos: nomes as TipoAutomacao[], erro: null };
}

export function filtrarPlano(plano: readonly ItemPlano[], tipos: readonly TipoAutomacao[]): ItemPlano[] {
  if (tipos.length === 0) {
    return [...plano];
  }
  return plano.filter((item) => tipos.includes(item.tipo));
}

function lerItemPlano(
  tipo: TipoAutomacao,
  variaveis: Record<string, string | undefined>,
): ItemPlano {
  const variavel = nomeVariavelDoTipo(tipo);
  const bruto = variaveis[variavel];
  if (bruto === undefined || bruto.trim() === '') {
    return {
      tipo,
      acao: 'pular',
      variavel,
      payload: null,
      mensagem: 'variável ' + variavel + ' ausente',
    };
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(bruto);
  } catch {
    return {
      tipo,
      acao: 'invalido',
      variavel,
      payload: null,
      mensagem: 'JSON inválido em ' + variavel,
    };
  }
  const validado = validarPayloadDoTipo(tipo, parsed);
  if (!validado.ok) {
    return { tipo, acao: 'invalido', variavel, payload: null, mensagem: validado.mensagem };
  }
  return { tipo, acao: 'executar', variavel, payload: validado.payload, mensagem: null };
}

export function ehStatusTerminal(status: string): boolean {
  return STATUS_TERMINAIS.includes(status);
}

export function deveContinuarPoll(status: string): boolean {
  return !ehStatusTerminal(status);
}

export function estourouOrcamento(
  inicioMs: number,
  agoraMs: number,
  orcamentoMs: number = ORCAMENTO_POR_ROBOT_MS,
): boolean {
  return agoraMs - inicioMs >= orcamentoMs;
}

export function linhaDoDesfecho(desfecho: DesfechoExecucao): LinhaRelatorio {
  if (desfecho.status === 'SUCCESS' && desfecho.sucesso !== false) {
    return {
      tipo: desfecho.tipo,
      resultado: 'OK',
      duracaoMs: desfecho.duracaoMs,
      observacao: desfecho.cacheHit === true ? 'CACHE' : '',
    };
  }
  if (desfecho.status === 'SUCCESS') {
    return {
      tipo: desfecho.tipo,
      resultado: 'FAIL',
      duracaoMs: desfecho.duracaoMs,
      observacao: comCache(
        desfecho.erro ?? 'robô concluiu com sucesso=false',
        desfecho.cacheHit,
      ),
    };
  }
  if (desfecho.status === 'CANCELLED') {
    return {
      tipo: desfecho.tipo,
      resultado: 'FAIL',
      duracaoMs: desfecho.duracaoMs,
      observacao: comCache('execução cancelada', desfecho.cacheHit),
    };
  }
  return {
    tipo: desfecho.tipo,
    resultado: 'FAIL',
    duracaoMs: desfecho.duracaoMs,
    observacao: comCache(desfecho.erro ?? 'status ' + desfecho.status, desfecho.cacheHit),
  };
}

function comCache(observacao: string, cacheHit: boolean | undefined): string {
  if (cacheHit !== true) {
    return observacao;
  }
  if (observacao === '') {
    return 'CACHE';
  }
  return observacao + ' | CACHE';
}

function copiarResultado(
  fonte: Record<string, unknown>,
): { sucesso: boolean; dados: Record<string, unknown>; mensagem?: string } | null {
  const sucesso = fonte['sucesso'];
  const dados: unknown = fonte['dados'];
  if (typeof sucesso !== 'boolean' || typeof dados !== 'object' || dados === null) {
    return null;
  }
  if (Array.isArray(dados)) {
    return null;
  }
  const saida: { sucesso: boolean; dados: Record<string, unknown>; mensagem?: string } = {
    sucesso,
    dados: dados as Record<string, unknown>,
  };
  const mensagem = fonte['mensagem'];
  if (typeof mensagem === 'string' && mensagem !== '') {
    saida.mensagem = mensagem;
  }
  return saida;
}

function copiarCache(fonte: Record<string, unknown>): ExecucaoResposta['cache'] {
  const bruto: unknown = fonte['cache'];
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) {
    return undefined;
  }
  const registro = bruto as Record<string, unknown>;
  if (registro['hit'] !== true && registro['hit'] !== false) {
    return undefined;
  }
  const saida: { hit: boolean; camada?: 'memoria' | 'sqlite'; ttlRestanteSeg?: number } = {
    hit: registro['hit'],
  };
  const camada = registro['camada'];
  if (camada === 'memoria' || camada === 'sqlite') {
    saida.camada = camada;
  }
  const ttl = registro['ttlRestanteSeg'];
  if (typeof ttl === 'number' && Number.isFinite(ttl) && ttl >= 0) {
    saida.ttlRestanteSeg = ttl;
  }
  return saida;
}

export function normalizarExecucao(corpo: unknown): ExecucaoResposta | null {
  if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo)) {
    return null;
  }
  const registro = corpo as Record<string, unknown>;
  const execucaoId = registro['execucaoId'];
  const status = registro['status'];
  if (typeof execucaoId !== 'string' || typeof status !== 'string') {
    return null;
  }
  if (
    status !== 'PENDING' &&
    status !== 'RUNNING' &&
    status !== 'SUCCESS' &&
    status !== 'FAILED' &&
    status !== 'CANCELLED'
  ) {
    return null;
  }
  const saida: ExecucaoResposta = {
    execucaoId,
    status: status as ExecucaoResposta['status'],
  };
  const cache = copiarCache(registro);
  if (cache !== undefined) {
    saida.cache = cache;
  }
  const aninhado = registro['resultado'];
  if (typeof aninhado === 'object' && aninhado !== null && !Array.isArray(aninhado)) {
    const copiado = copiarResultado(aninhado as Record<string, unknown>);
    if (copiado !== null) {
      saida.resultado = copiado;
    }
  } else {
    const copiado = copiarResultado(registro);
    if (copiado !== null) {
      saida.resultado = copiado;
    }
  }
  const erro = registro['error'];
  if (typeof erro === 'object' && erro !== null && !Array.isArray(erro)) {
    const detalhe = erro as Record<string, unknown>;
    const codigo = detalhe['code'];
    const mensagem = detalhe['message'];
    if (typeof codigo === 'string' && typeof mensagem === 'string') {
      saida.error = { code: codigo, message: mensagem };
    }
  }
  const duracao = registro['duracaoMs'];
  if (typeof duracao === 'number') {
    saida.duracaoMs = duracao;
  }
  return saida;
}

export function linhaDeTimeout(tipo: TipoAutomacao, duracaoMs: number): LinhaRelatorio {
  const segundos = Math.round(duracaoMs / 1000);
  return {
    tipo,
    resultado: 'TIMEOUT',
    duracaoMs,
    observacao: 'sem conclusão em ' + String(segundos) + 's',
  };
}

export function linhaDeSkip(tipo: TipoAutomacao, motivo: string): LinhaRelatorio {
  return { tipo, resultado: 'SKIP', duracaoMs: null, observacao: motivo };
}

export function linhaDeEntradaInvalida(item: ItemPlano): LinhaRelatorio {
  return {
    tipo: item.tipo,
    resultado: 'FAIL',
    duracaoMs: null,
    observacao: item.mensagem ?? 'payload inválido',
  };
}

export function formatarDuracao(duracaoMs: number | null): string {
  if (duracaoMs === null) {
    return '-';
  }
  return (duracaoMs / 1000).toFixed(1).replace('.', ',') + 's';
}

export function calcularExitCode(linhas: LinhaRelatorio[]): 0 | 1 {
  for (const linha of linhas) {
    if (linha.resultado === 'FAIL' || linha.resultado === 'TIMEOUT') {
      return 1;
    }
  }
  return 0;
}

export function montarRelatorio(linhas: LinhaRelatorio[]): RelatorioSmoke {
  const cabecalho = 'ROBOT | RESULTADO | DURACAO | OBS';
  const corpo = linhas.map((linha) => {
    const obs = linha.observacao === '' ? '-' : linha.observacao;
    return (
      linha.tipo +
      ' | ' +
      linha.resultado +
      ' | ' +
      formatarDuracao(linha.duracaoMs) +
      ' | ' +
      obs
    );
  });
  let ok = 0;
  let fail = 0;
  let skip = 0;
  let timeout = 0;
  for (const linha of linhas) {
    if (linha.resultado === 'OK') {
      ok += 1;
    } else if (linha.resultado === 'FAIL') {
      fail += 1;
    } else if (linha.resultado === 'SKIP') {
      skip += 1;
    } else {
      timeout += 1;
    }
  }
  const resumo =
    'Resumo: ' +
    String(ok) +
    ' ok, ' +
    String(fail) +
    ' fail, ' +
    String(skip) +
    ' skip, ' +
    String(timeout) +
    ' timeout';
  const texto = ['Smoke e2e contra portais reais', cabecalho, ...corpo, resumo].join('\n');
  return { texto, exitCode: calcularExitCode(linhas) };
}

export function drenarStdout(texto: string): Promise<void> {
  return new Promise<void>((resolver) => {
    process.stdout.write(texto + '\n', () => resolver());
  });
}
