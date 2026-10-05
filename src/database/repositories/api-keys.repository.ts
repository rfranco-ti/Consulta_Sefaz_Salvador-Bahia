import type Database from 'better-sqlite3';
import { ConflictError, NotFoundError } from '../../shared/errors/index.js';
import { agoraIso, ehViolacaoUnica, exigirTexto } from '../sqlite-erros.js';

export interface ApiKey {
  id: string;
  nome: string;
  keyHash: string;
  ativa: boolean;
  criadaEm: string;
  ultimoUsoEm: string | null;
}

export interface CriarApiKeyInput {
  id: string;
  nome: string;
  keyHash: string;
}

interface ApiKeyLinha {
  id: string;
  nome: string;
  key_hash: string;
  ativa: number;
  criada_em: string;
  ultimo_uso_em: string | null;
}

const COLUNAS = 'id, nome, key_hash, ativa, criada_em, ultimo_uso_em';

function paraApiKey(linha: ApiKeyLinha): ApiKey {
  return {
    id: linha.id,
    nome: linha.nome,
    keyHash: linha.key_hash,
    ativa: linha.ativa === 1,
    criadaEm: linha.criada_em,
    ultimoUsoEm: linha.ultimo_uso_em,
  };
}

export class ApiKeysRepository {
  constructor(private readonly banco: Database.Database) {}

  criar(input: CriarApiKeyInput): ApiKey {
    exigirTexto(input.id, 'Identificador da chave de API é obrigatório');
    exigirTexto(input.nome, 'Nome da chave de API é obrigatório');
    exigirTexto(input.keyHash, 'Hash da chave de API é obrigatório');
    try {
      this.banco
        .prepare<[string, string, string, string]>(
          'INSERT INTO api_keys (id, nome, key_hash, ativa, criada_em, ultimo_uso_em) VALUES (?, ?, ?, 1, ?, NULL)',
        )
        .run(input.id, input.nome, input.keyHash, agoraIso());
    } catch (erro) {
      if (ehViolacaoUnica(erro)) {
        throw new ConflictError('Chave de API já cadastrada');
      }
      throw erro;
    }
    return this.buscarPorIdOuFalhar(input.id);
  }

  listar(): ApiKey[] {
    const linhas = this.banco
      .prepare<[], ApiKeyLinha>(`SELECT ${COLUNAS} FROM api_keys ORDER BY criada_em ASC`)
      .all();
    return linhas.map(paraApiKey);
  }

  listarAtivas(): ApiKey[] {
    const linhas = this.banco
      .prepare<[], ApiKeyLinha>(
        `SELECT ${COLUNAS} FROM api_keys WHERE ativa = 1 ORDER BY criada_em ASC`,
      )
      .all();
    return linhas.map(paraApiKey);
  }

  buscarPorId(id: string): ApiKey | null {
    const linha = this.banco
      .prepare<[string], ApiKeyLinha>(`SELECT ${COLUNAS} FROM api_keys WHERE id = ?`)
      .get(id);
    return linha === undefined ? null : paraApiKey(linha);
  }

  buscarPorHash(keyHash: string): ApiKey | null {
    const linha = this.banco
      .prepare<[string], ApiKeyLinha>(`SELECT ${COLUNAS} FROM api_keys WHERE key_hash = ?`)
      .get(keyHash);
    return linha === undefined ? null : paraApiKey(linha);
  }

  revogar(id: string): ApiKey {
    const info = this.banco
      .prepare<[string]>('UPDATE api_keys SET ativa = 0 WHERE id = ?')
      .run(id);
    if (info.changes === 0) {
      throw new NotFoundError('Chave de API não encontrada');
    }
    return this.buscarPorIdOuFalhar(id);
  }

  registrarUso(id: string, em: string = agoraIso()): ApiKey {
    const info = this.banco
      .prepare<[string, string]>('UPDATE api_keys SET ultimo_uso_em = ? WHERE id = ?')
      .run(em, id);
    if (info.changes === 0) {
      throw new NotFoundError('Chave de API não encontrada');
    }
    return this.buscarPorIdOuFalhar(id);
  }

  private buscarPorIdOuFalhar(id: string): ApiKey {
    const chave = this.buscarPorId(id);
    if (chave === null) {
      throw new NotFoundError('Chave de API não encontrada');
    }
    return chave;
  }
}
