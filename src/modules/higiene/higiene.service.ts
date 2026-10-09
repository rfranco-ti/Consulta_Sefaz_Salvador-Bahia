import { rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { CacheRepository } from '../../database/repositories/cache.repository.js';
import {
  DocumentosRepository,
  type Documento,
} from '../../database/repositories/documentos.repository.js';
import { logger as loggerPadrao } from '../../shared/logger/index.js';

export interface ResumoHigiene {
  cacheRemovido: number;
  documentosRemovidos: number;
  arquivosRemovidos: number;
  arquivosAusentes: number;
}

export interface DepsHigiene {
  banco: Database.Database;
  diretorioArmazenamento: string;
  ttlDiasDocumentos: number;
  agora?: () => Date;
}

export interface OpcoesHigiene extends DepsHigiene {
  intervaloMin: number;
  executarNaPartida?: boolean;
  logger?: Logger;
}

const MS_POR_DIA = 86_400_000;

export function executarHigiene(deps: DepsHigiene): ResumoHigiene {
  const referencia = deps.agora?.() ?? new Date();
  const agoraTexto = referencia.toISOString();
  const corte = new Date(referencia.getTime() - deps.ttlDiasDocumentos * MS_POR_DIA).toISOString();
  const cache = new CacheRepository(deps.banco);
  const documentos = new DocumentosRepository(deps.banco);
  const cacheRemovido = cache.removerExpirados(agoraTexto);
  const expirados = documentos.removerExpiradosEm(agoraTexto);
  const legados = documentos.removerExpiradosLegados(corte);
  const removidos = [...expirados, ...legados];
  const base = resolve(deps.diretorioArmazenamento);
  let arquivosRemovidos = 0;
  let arquivosAusentes = 0;
  for (const documento of removidos) {
    if (removerArquivoDocumento(base, documento)) {
      arquivosRemovidos += 1;
    } else {
      arquivosAusentes += 1;
    }
  }
  return {
    cacheRemovido,
    documentosRemovidos: removidos.length,
    arquivosRemovidos,
    arquivosAusentes,
  };
}

function dentroDaBase(base: string, arquivo: string): boolean {
  return arquivo === base || arquivo.startsWith(base + sep);
}

function removerArquivoDocumento(base: string, documento: Documento): boolean {
  const arquivo = resolve(join(base, documento.caminho));
  if (!dentroDaBase(base, arquivo)) {
    return false;
  }
  let removido = false;
  try {
    unlinkSync(arquivo);
    removido = true;
  } catch {
    removido = false;
  }
  const diretorio = dirname(arquivo);
  if (diretorio !== base) {
    try {
      rmdirSync(diretorio);
    } catch {
      return removido;
    }
  }
  return removido;
}

let temporizador: NodeJS.Timeout | null = null;
let emExecucao = false;

export function higieneAtiva(): boolean {
  return temporizador !== null;
}

export function iniciarHigiene(opcoes: OpcoesHigiene): void {
  if (temporizador !== null) {
    return;
  }
  const logger = opcoes.logger ?? loggerPadrao;
  if (opcoes.executarNaPartida ?? true) {
    rodarUmaVez(opcoes, logger);
  }
  const intervaloMs = opcoes.intervaloMin * 60_000;
  const id = setInterval(() => {
    rodarUmaVez(opcoes, logger);
  }, intervaloMs);
  id.unref();
  temporizador = id;
  logger.info({ intervaloMin: opcoes.intervaloMin }, 'higiene periódica iniciada');
}

export function pararHigiene(): void {
  if (temporizador !== null) {
    clearInterval(temporizador);
    temporizador = null;
  }
}

function rodarUmaVez(opcoes: OpcoesHigiene, logger: Logger): void {
  if (emExecucao) {
    logger.warn('execução da higiene ignorada por sobreposição');
    return;
  }
  emExecucao = true;
  try {
    const resumo = executarHigiene(opcoes);
    logger.info(resumo, 'higiene concluída');
  } catch (erro) {
    logger.error({ err: erro }, 'falha na higiene periódica');
  } finally {
    emExecucao = false;
  }
}
