import type Database from 'better-sqlite3';
import { ehTipoAutomacao, type TipoAutomacao } from '../../automations/registry.js';
import { ValidationError } from '../../shared/errors/index.js';
import { agoraIso, exigirTexto } from '../sqlite-erros.js';

export interface EntradaCache {
  chave: string;
  tipo: TipoAutomacao;
  dados: string;
  cacheVersion: number;
  criadoEm: string;
  expiraEm: string;
  tamanhoBytes: number;
}

export interface SalvarCacheInput {
  chave: string;
  tipo: string;
  dados: string;
  cacheVersion: number;
  ttlMs: number;
}

interface CacheLinha {
  chave: string;
  tipo: string;
  dados: string;
  cache_version: number;
  criado_em: string;
  expira_em: string;
  tamanho_bytes: number;
}

const COLUNAS = 'chave, tipo, dados, cache_version, criado_em, expira_em, tamanho_bytes';

function paraEntrada(linha: CacheLinha): EntradaCache {
  return {
    chave: linha.chave,
    tipo: linha.tipo as TipoAutomacao,
    dados: linha.dados,
    cacheVersion: linha.cache_version,
    criadoEm: linha.criado_em,
    expiraEm: linha.expira_em,
    tamanhoBytes: linha.tamanho_bytes,
  };
}

function exigirDadosValidos(dados: string): void {
  exigirTexto(dados, 'Somente resultados válidos podem ser armazenados no cache');
  try {
    JSON.parse(dados);
  } catch {
    throw new ValidationError('Somente resultados válidos podem ser armazenados no cache');
  }
}

export class CacheRepository {
  constructor(private readonly banco: Database.Database) {}

  salvar(input: SalvarCacheInput): EntradaCache {
    exigirTexto(input.chave, 'Chave do cache é obrigatória');
    if (!ehTipoAutomacao(input.tipo)) {
      throw new ValidationError(`Tipo de automação inválido: ${input.tipo}`);
    }
    exigirDadosValidos(input.dados);
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      throw new ValidationError('TTL do cache deve ser positivo');
    }
    const criadoEm = agoraIso();
    const expiraEm = new Date(Date.now() + input.ttlMs).toISOString();
    const tamanhoBytes = Buffer.byteLength(input.dados, 'utf8');
    this.banco
      .prepare<[string, string, string, number, string, string, number]>(
        'INSERT OR REPLACE INTO cache_consultas (chave, tipo, dados, cache_version, criado_em, expira_em, tamanho_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(input.chave, input.tipo, input.dados, input.cacheVersion, criadoEm, expiraEm, tamanhoBytes);
    return {
      chave: input.chave,
      tipo: input.tipo,
      dados: input.dados,
      cacheVersion: input.cacheVersion,
      criadoEm,
      expiraEm,
      tamanhoBytes,
    };
  }

  obter(chave: string, agora: string = agoraIso()): EntradaCache | null {
    const linha = this.banco
      .prepare<[string], CacheLinha>(`SELECT ${COLUNAS} FROM cache_consultas WHERE chave = ?`)
      .get(chave);
    if (linha === undefined || linha.expira_em <= agora) {
      return null;
    }
    return paraEntrada(linha);
  }

  invalidarTipo(tipo: string): number {
    const info = this.banco
      .prepare<[string]>('DELETE FROM cache_consultas WHERE tipo = ?')
      .run(tipo);
    return info.changes;
  }

  invalidarVersoesAnteriores(tipo: string, versaoAtual: number): number {
    const info = this.banco
      .prepare<[string, number]>('DELETE FROM cache_consultas WHERE tipo = ? AND cache_version != ?')
      .run(tipo, versaoAtual);
    return info.changes;
  }

  removerExpirados(agora: string = agoraIso()): number {
    const info = this.banco
      .prepare<[string]>('DELETE FROM cache_consultas WHERE expira_em <= ?')
      .run(agora);
    return info.changes;
  }
}
