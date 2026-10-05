import type { TipoAutomacao } from '../../automations/registry.js';

export type ArtefatosOpcao = 'nenhum' | 'pdf' | 'print' | 'ambos';

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
