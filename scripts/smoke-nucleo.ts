import type { ZodError } from 'zod';
import { TIPOS_AUTOMACAO, type TipoAutomacao } from '../src/automations/registry.js';
import { schemaDoTipo } from '../src/modules/automation/automation.schemas.js';

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
    return { tipo: desfecho.tipo, resultado: 'OK', duracaoMs: desfecho.duracaoMs, observacao: '' };
  }
  if (desfecho.status === 'SUCCESS') {
    return {
      tipo: desfecho.tipo,
      resultado: 'FAIL',
      duracaoMs: desfecho.duracaoMs,
      observacao: desfecho.erro ?? 'robô concluiu com sucesso=false',
    };
  }
  if (desfecho.status === 'CANCELLED') {
    return {
      tipo: desfecho.tipo,
      resultado: 'FAIL',
      duracaoMs: desfecho.duracaoMs,
      observacao: 'execução cancelada',
    };
  }
  return {
    tipo: desfecho.tipo,
    resultado: 'FAIL',
    duracaoMs: desfecho.duracaoMs,
    observacao: desfecho.erro ?? 'status ' + desfecho.status,
  };
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
