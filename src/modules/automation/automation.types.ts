import type { TipoAutomacao } from '../../automations/registry.js';

export type ExecucaoStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';

export type ArtefatosOpcao = 'nenhum' | 'pdf' | 'print' | 'ambos';

/**
 * Valor resolvido do parâmetro de controle `file` (opt-in de download binário).
 * `principal` corresponde a `file=true`: o primeiro PDF, ou o primeiro print
 * quando não houver PDF. Nunca compõe a chave de cache nem o payload do robô.
 */
export type ArquivoSolicitado = 'pdf' | 'print' | 'principal';

export interface DocumentoInfo {
  id: string;
  tipo: 'pdf_oficial' | 'pdf_pagina' | 'print' | 'boleto';
  nome: string;
  contentType: 'application/pdf' | 'image/jpeg';
  tamanhoBytes: number;
  url: string;
}

export interface CacheInfo {
  hit: boolean;
  camada?: 'memoria' | 'sqlite';
  ttlRestanteSeg?: number;
}

export interface ResultadoAutomacao {
  sucesso: boolean;
  dados: Record<string, unknown>;
  documentos?: DocumentoInfo[];
  mensagem?: string;
  avisos?: string[];
}

export interface ExecucaoResposta {
  execucaoId: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  posicaoFila?: number | null;
  cache?: CacheInfo;
  resultado?: ResultadoAutomacao | null;
  error?: { code: string; message: string; etapa?: string } | null;
  duracaoMs?: number;
}

export interface IniciarExecucaoInput {
  tipo: TipoAutomacao;
  params: Record<string, unknown>;
  artefatos: ArtefatosOpcao;
  inline: boolean;
  forceRefresh: boolean;
  apiKeyId: string;
  idempotencyKey?: string;
}

export interface ConsultarComCacheInput<T> {
  tipo: TipoAutomacao;
  payload: unknown;
  forceRefresh?: boolean;
  executar: () => Promise<T>;
}

export interface ConsultarComCacheSaida<T> {
  resultado: T;
  cache: CacheInfo;
}

export interface ConsultarSincronaInput extends IniciarExecucaoInput {
  waitSeg: number;
}
