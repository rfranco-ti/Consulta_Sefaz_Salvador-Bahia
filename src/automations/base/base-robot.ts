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
