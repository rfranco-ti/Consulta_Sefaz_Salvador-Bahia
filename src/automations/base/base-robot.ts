import type { Logger } from 'pino';
import { logger as loggerPadrao } from '../../shared/logger/index.js';
import type { ArtefatosOpcao } from '../../modules/automation/automation.types.js';
import type { BrowserSession } from '../../modules/browser/browser.types.js';

export type ProgressoNivel = 'log' | 'warn' | 'error';

/** Callback de progresso da execucao (alimenta o SSE). */
export type ProgressoCallback = (nivel: ProgressoNivel, mensagem: string) => void;

/**
 * Contexto recebido por cada robot na execucao (AUTOMATIONS.md).
 * Carrega tudo o que o robot precisa — sem DI do framework.
 */
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
}

export interface ResultadoRobot {
  sucesso: boolean;
  dados: Record<string, unknown>;
  mensagem?: string;
}

/**
 * Base dos robots (.docs/AUTOMATIONS.md, PLAYWRIGHT.md).
 *
 * Regras obrigatorias de todo robot:
 * - validar entrada antes de abrir browser
 * - extrair dados PRIMEIRO; artefatos POR ULTIMO (so se pedidos)
 * - try/finally liberando a sessao
 * - timeout proprio menor que o global
 * - progresso por etapas via ctx.emitir
 *
 * TODO(Fase 4): adicionar helpers de artefatos (capturarArtefatos) e
 * espera de sessao (executarComSessao) conforme o porte do eContabil.
 */
export abstract class BaseRobot {
  abstract readonly tipo: string;
  abstract readonly nome: string;
  abstract readonly portal: string;

  protected readonly logger: Logger;

  constructor(logger: Logger = loggerPadrao) {
    // new.target = classe concreta (evita ler props abstratas no construtor)
    this.logger = logger.child({ robot: new.target.name });
  }

  /** Log estruturado + progresso (SSE) da execucao atual. */
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
