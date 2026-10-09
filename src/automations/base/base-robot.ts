import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger } from 'pino';
import { logger as loggerPadrao } from '../../shared/logger/index.js';
import type { ArtefatosOpcao } from '../../modules/automation/automation.types.js';
import type { BrowserSession } from '../../modules/browser/browser.types.js';

export type ProgressoNivel = 'log' | 'warn' | 'error';

export type ProgressoCallback = (nivel: ProgressoNivel, mensagem: string) => void;

export interface ExecucaoCtx {
  sessao: BrowserSession;
  emitir(nivel: ProgressoNivel, mensagem: string): void;
  registrarArquivo(
    tipo: 'pdf_oficial' | 'pdf_pagina' | 'print' | 'boleto',
    caminho: string,
    contentType: 'application/pdf' | 'image/jpeg',
  ): void;
  artefatos: ArtefatosOpcao;
  signal: AbortSignal;
  /**
   * Identificador estável da execução (o `id` da execução que originou o trabalho).
   * Usado para isolar diretórios temporários de artefatos: duas execuções
   * concorrentes com os mesmos parâmetros de negócio (CNPJ, CPF, ...) nunca
   * partilham o mesmo diretório.
   */
  execucaoId: string;
}

/**
 * Normaliza um segmento de nome de diretório para caracteres seguros,
 * preservando legibilidade para depuração.
 */
function sanitizarSegmento(valor: string): string {
  const limpo = valor
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return (limpo === '' ? 'x' : limpo).slice(0, 80);
}

/**
 * Monta o diretório temporário de artefatos de UMA execução: legível
 * (prefixo + parâmetros de negócio) e único por execução (sufixo do
 * identificador da execução). Os nomes de arquivo dentro dele permanecem
 * fixos (`print.jpg`, `pagina.pdf`, ...); a unicidade vem do diretório.
 */
export function diretorioArtefatosExecucao(
  prefixo: string,
  execucaoId: string,
  ...rotulos: Array<string | number>
): string {
  const partes = [
    sanitizarSegmento(prefixo),
    ...rotulos.map((rotulo) => sanitizarSegmento(String(rotulo))),
    sanitizarSegmento(execucaoId),
  ];
  return path.join(tmpdir(), 'api-sefaz-ssa', partes.join('-'));
}

/**
 * Remove os diretórios temporários de UMA execução, escopados por prefixo.
 * O escopo por prefixo é importante porque execuções filhas
 * (ex.: `consulta-inscricoes` reaproveita o mesmo `execucaoId` nos filhos
 * estadual e municipal, que rodam em paralelo) partilham o sufixo mas usam
 * prefixos diferentes — cada executor limpa apenas os seus.
 *
 * É seguro chamar após os bytes já terem sido lidos para base64 no wrapper
 * do executor: `AutomationService.persistirBlobs` consome o base64 presente
 * no resultado, nunca o arquivo temporário.
 */
export async function removerDiretoriosTemporariosDaExecucao(
  execucaoId: string,
  prefixos: string[],
): Promise<void> {
  const base = path.join(tmpdir(), 'api-sefaz-ssa');
  const sufixo = `-${sanitizarSegmento(execucaoId)}`;
  const inicios = prefixos.map((prefixo) => `${sanitizarSegmento(prefixo)}-`);
  let entradas: string[];
  try {
    entradas = await readdir(base);
  } catch {
    return;
  }
  const alvos = entradas.filter(
    (nome) => nome.endsWith(sufixo) && inicios.some((inicio) => nome.startsWith(inicio)),
  );
  await Promise.all(
    alvos.map((nome) => rm(path.join(base, nome), { recursive: true, force: true }).catch(() => undefined)),
  );
}

export interface ResultadoRobot {
  sucesso: boolean;
  dados: Record<string, unknown>;
  mensagem?: string;
}

export abstract class BaseRobot {
  abstract readonly tipo: string;
  abstract readonly nome: string;
  abstract readonly portal: string;

  protected readonly logger: Logger;

  constructor(logger: Logger = loggerPadrao) {
    this.logger = logger.child({ robot: new.target.name });
  }

  protected emitir(ctx: ExecucaoCtx, nivel: ProgressoNivel, mensagem: string): void {
    if (nivel === 'error') this.logger.error({ tipo: this.tipo }, mensagem);
    else if (nivel === 'warn') this.logger.warn({ tipo: this.tipo }, mensagem);
    else this.logger.info({ tipo: this.tipo }, mensagem);
    ctx.emitir(nivel, mensagem);
  }

  abstract executar(
    params: Record<string, unknown>,
    ctx: ExecucaoCtx,
  ): Promise<ResultadoRobot>;
}
