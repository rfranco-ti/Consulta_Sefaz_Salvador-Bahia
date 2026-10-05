import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/database/client.js';
import {
  aplicarMigrations,
  listarMigrationsAplicadas,
} from '../../src/database/migrations/index.js';
import { criarBancoTemporario } from './database-helpers.js';

function nomesTabelas(banco: Database.Database): string[] {
  const linhas = banco
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC",
    )
    .all();
  return linhas.map((linha) => linha.name);
}

function colunasDe(banco: Database.Database, tabela: string): string[] {
  const linhas = banco.prepare<[], { name: string }>(`PRAGMA table_info(${tabela})`).all();
  return linhas.map((linha) => linha.name);
}

function esquemaOrdenado(banco: Database.Database): string {
  const linhas = banco
    .prepare<[], { type: string; name: string; sql: string | null }>(
      'SELECT type, name, sql FROM sqlite_master ORDER BY name ASC',
    )
    .all();
  return JSON.stringify(linhas);
}

describe('migrations', () => {
  it('cria exatamente as tabelas do contrato', () => {
    const { banco, limpar } = criarBancoTemporario();
    try {
      expect(nomesTabelas(banco)).toEqual([
        'api_keys',
        'cache_consultas',
        'documentos',
        'execucoes',
        'execucoes_participantes',
        'schema_migrations',
      ]);
    } finally {
      limpar();
    }
  });

  it('cria as colunas exatas de cada tabela', () => {
    const { banco, limpar } = criarBancoTemporario();
    try {
      expect(colunasDe(banco, 'api_keys')).toEqual([
        'id',
        'nome',
        'key_hash',
        'ativa',
        'criada_em',
        'ultimo_uso_em',
      ]);
      expect(colunasDe(banco, 'execucoes')).toEqual([
        'id',
        'tipo',
        'status',
        'payload',
        'payload_bruto',
        'resultado',
        'error',
        'attempts',
        'api_key_id',
        'ticket',
        'cache_version',
        'posicao_fila',
        'criado_em',
        'iniciado_em',
        'finalizado_em',
        'duracao_ms',
      ]);
      expect(colunasDe(banco, 'execucoes_participantes')).toEqual(['execucao_id', 'api_key_id']);
      expect(colunasDe(banco, 'documentos')).toEqual([
        'id',
        'execucao_id',
        'api_key_id',
        'tipo',
        'caminho',
        'content_type',
        'nome_arquivo',
        'tamanho_bytes',
        'criado_em',
      ]);
      expect(colunasDe(banco, 'cache_consultas')).toEqual([
        'chave',
        'tipo',
        'dados',
        'cache_version',
        'criado_em',
        'expira_em',
        'tamanho_bytes',
      ]);
      expect(colunasDe(banco, 'schema_migrations')).toEqual(['nome', 'aplicado_em']);
    } finally {
      limpar();
    }
  });

  it('cria os índices do contrato', () => {
    const { banco, limpar } = criarBancoTemporario();
    try {
      const linhas = banco
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name ASC",
        )
        .all();
      expect(linhas.map((linha) => linha.name)).toEqual([
        'idx_cache_expira_em',
        'idx_cache_tipo',
        'idx_execucoes_criado_em',
        'idx_execucoes_status_ticket',
        'idx_execucoes_tipo_status',
      ]);
    } finally {
      limpar();
    }
  });

  it('registra a migração aplicada na tabela de controle', () => {
    const { banco, limpar } = criarBancoTemporario();
    try {
      expect(listarMigrationsAplicadas(banco)).toEqual(['001-schema-inicial']);
    } finally {
      limpar();
    }
  });

  it('é idempotente: segunda aplicação não altera o esquema', () => {
    const { banco, limpar } = criarBancoTemporario();
    try {
      const antes = esquemaOrdenado(banco);
      const novas = aplicarMigrations(banco);
      expect(novas).toEqual([]);
      expect(esquemaOrdenado(banco)).toBe(antes);
      expect(listarMigrationsAplicadas(banco)).toEqual(['001-schema-inicial']);
    } finally {
      limpar();
    }
  });

  it('aplica chaves estrangeiras entre execuções e chaves de API', () => {
    const { banco, limpar } = criarBancoTemporario();
    try {
      expect(() =>
        banco
          .prepare(
            "INSERT INTO execucoes (id, tipo, status, payload, payload_bruto, attempts, api_key_id, ticket, cache_version, criado_em) VALUES ('exe_sem_chave', 'sefaz-bahia', 'PENDING', '{}', '{}', 0, 'key_inexistente', 1, 1, '2026-01-01T00:00:00.000Z')",
          )
          .run(),
      ).toThrow(/FOREIGN KEY constraint failed/);
      const chaves = banco
        .prepare<[], { tabela: string }>(
          "SELECT \"table\" AS tabela FROM pragma_foreign_key_list('execucoes')",
        )
        .all();
      expect(chaves.map((chave) => chave.tabela)).toContain('api_keys');
    } finally {
      limpar();
    }
  });

  it('abre banco em diretório inexistente criando o caminho', () => {
    const { limpar, diretorio } = criarBancoTemporario();
    try {
      const outro = openDatabase(join(diretorio, 'sub', 'dir', 'teste.sqlite'));
      try {
        expect(aplicarMigrations(outro)).toEqual(['001-schema-inicial']);
        expect(nomesTabelas(outro)).toContain('execucoes');
      } finally {
        outro.close();
      }
    } finally {
      limpar();
    }
  });
});
