import { isAbsolute } from 'node:path';
import type Database from 'better-sqlite3';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/index.js';
import { agoraIso, ehViolacaoChaveEstrangeira, ehViolacaoUnica, exigirTexto } from '../sqlite-erros.js';

export type TipoDocumento = 'pdf_oficial' | 'pdf_pagina' | 'print' | 'boleto';

export type ContentTypeDocumento = 'application/pdf' | 'image/jpeg';

export interface Documento {
  id: string;
  execucaoId: string;
  apiKeyId: string;
  tipo: TipoDocumento;
  caminho: string;
  contentType: ContentTypeDocumento;
  nomeArquivo: string;
  tamanhoBytes: number;
  criadoEm: string;
}

export interface InserirDocumentoInput {
  id: string;
  execucaoId: string;
  apiKeyId: string;
  tipo: string;
  caminho: string;
  contentType: string;
  nomeArquivo: string;
  tamanhoBytes: number;
  criadoEm?: string;
}

interface DocumentoLinha {
  id: string;
  execucao_id: string;
  api_key_id: string;
  tipo: string;
  caminho: string;
  content_type: string;
  nome_arquivo: string;
  tamanho_bytes: number;
  criado_em: string;
}

const COLUNAS =
  'id, execucao_id, api_key_id, tipo, caminho, content_type, nome_arquivo, tamanho_bytes, criado_em';

const TIPOS_DOCUMENTO: readonly string[] = ['pdf_oficial', 'pdf_pagina', 'print', 'boleto'];

const CONTENT_TYPES: readonly string[] = ['application/pdf', 'image/jpeg'];

function paraDocumento(linha: DocumentoLinha): Documento {
  return {
    id: linha.id,
    execucaoId: linha.execucao_id,
    apiKeyId: linha.api_key_id,
    tipo: linha.tipo as TipoDocumento,
    caminho: linha.caminho,
    contentType: linha.content_type as ContentTypeDocumento,
    nomeArquivo: linha.nome_arquivo,
    tamanhoBytes: linha.tamanho_bytes,
    criadoEm: linha.criado_em,
  };
}

export class DocumentosRepository {
  constructor(private readonly banco: Database.Database) {}

  inserir(input: InserirDocumentoInput): Documento {
    exigirTexto(input.id, 'Identificador do documento é obrigatório');
    exigirTexto(input.execucaoId, 'Identificador da execução é obrigatório');
    exigirTexto(input.apiKeyId, 'Identificador da chave de API é obrigatório');
    exigirTexto(input.caminho, 'Caminho do documento é obrigatório');
    exigirTexto(input.nomeArquivo, 'Nome do arquivo do documento é obrigatório');
    if (!TIPOS_DOCUMENTO.includes(input.tipo)) {
      throw new ValidationError(`Tipo de documento inválido: ${input.tipo}`);
    }
    if (!CONTENT_TYPES.includes(input.contentType)) {
      throw new ValidationError(`Tipo de conteúdo do documento é inválido: ${input.contentType}`);
    }
    if (isAbsolute(input.caminho)) {
      throw new ValidationError('Caminho do documento deve ser relativo ao diretório de armazenamento');
    }
    if (!Number.isInteger(input.tamanhoBytes) || input.tamanhoBytes < 0) {
      throw new ValidationError('Tamanho do documento deve ser um inteiro não negativo');
    }
    const criadoEm = input.criadoEm ?? agoraIso();
    try {
      this.banco
        .prepare<[string, string, string, string, string, string, string, number, string]>(
          'INSERT INTO documentos (id, execucao_id, api_key_id, tipo, caminho, content_type, nome_arquivo, tamanho_bytes, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          input.id,
          input.execucaoId,
          input.apiKeyId,
          input.tipo,
          input.caminho,
          input.contentType,
          input.nomeArquivo,
          input.tamanhoBytes,
          criadoEm,
        );
    } catch (erro) {
      if (ehViolacaoUnica(erro)) {
        throw new ConflictError('Documento já cadastrado');
      }
      if (ehViolacaoChaveEstrangeira(erro)) {
        throw new ValidationError('Execução não encontrada para o documento');
      }
      throw erro;
    }
    return this.buscarPorIdOuFalhar(input.id);
  }

  buscarPorId(id: string): Documento | null {
    const linha = this.banco
      .prepare<[string], DocumentoLinha>(`SELECT ${COLUNAS} FROM documentos WHERE id = ?`)
      .get(id);
    return linha === undefined ? null : paraDocumento(linha);
  }

  listarPorExecucao(execucaoId: string): Documento[] {
    const linhas = this.banco
      .prepare<[string], DocumentoLinha>(
        `SELECT ${COLUNAS} FROM documentos WHERE execucao_id = ? ORDER BY criado_em ASC`,
      )
      .all(execucaoId);
    return linhas.map(paraDocumento);
  }

  removerExpirados(criadoAntesDe: string): Documento[] {
    const remover = this.banco.transaction((): Documento[] => {
      const expirados = this.banco
        .prepare<[string], DocumentoLinha>(
          `SELECT ${COLUNAS} FROM documentos WHERE criado_em < ?`,
        )
        .all(criadoAntesDe);
      this.banco
        .prepare<[string]>('DELETE FROM documentos WHERE criado_em < ?')
        .run(criadoAntesDe);
      return expirados.map(paraDocumento);
    });
    return remover();
  }

  private buscarPorIdOuFalhar(id: string): Documento {
    const documento = this.buscarPorId(id);
    if (documento === null) {
      throw new NotFoundError('Documento não encontrado');
    }
    return documento;
  }
}
