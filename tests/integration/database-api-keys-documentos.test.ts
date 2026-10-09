import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/database/client.js';
import { MIGRACAO_SCHEMA_INICIAL } from '../../src/database/migrations/001-schema-inicial.js';
import { MIGRACAO_IDEMPOTENCY_KEY } from '../../src/database/migrations/002-idempotency-key.js';
import {
  aplicarMigrations,
  listarMigrationsAplicadas,
} from '../../src/database/migrations/index.js';
import { ApiKeysRepository } from '../../src/database/repositories/api-keys.repository.js';
import { DocumentosRepository } from '../../src/database/repositories/documentos.repository.js';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../src/shared/errors/index.js';
import { criarBancoTemporario, criarChaveApi } from './database-helpers.js';

describe('chaves de API', () => {
  it('cria e busca por hash', () => {
    const { banco, limpar } = criarBancoTemporario();
    try {
      const repo = new ApiKeysRepository(banco);
      const criada = repo.criar({ id: 'key_1', nome: 'Integração', keyHash: 'hash_1' });
      expect(criada.ativa).toBe(true);
      expect(criada.ultimoUsoEm).toBeNull();
      expect(repo.buscarPorHash('hash_1')?.id).toBe('key_1');
      expect(repo.buscarPorHash('hash_inexistente')).toBeNull();
      expect(repo.buscarPorId('key_inexistente')).toBeNull();
    } finally {
      limpar();
    }
  });

  it('rejeita duplicadas com erro de conflito', () => {
    const { banco, limpar } = criarBancoTemporario();
    try {
      const repo = new ApiKeysRepository(banco);
      repo.criar({ id: 'key_dup', nome: 'Primeira', keyHash: 'hash_dup' });
      expect(() => repo.criar({ id: 'key_dup', nome: 'Segunda', keyHash: 'hash_outro' })).toThrow(
        ConflictError,
      );
      expect(() => repo.criar({ id: 'key_outra', nome: 'Terceira', keyHash: 'hash_dup' })).toThrow(
        ConflictError,
      );
    } finally {
      limpar();
    }
  });

  it('revoga e sai da lista de ativas', () => {
    const { banco, limpar } = criarBancoTemporario();
    try {
      const repo = new ApiKeysRepository(banco);
      repo.criar({ id: 'key_r1', nome: 'Uma', keyHash: 'hash_r1' });
      repo.criar({ id: 'key_r2', nome: 'Outra', keyHash: 'hash_r2' });
      const revogada = repo.revogar('key_r1');
      expect(revogada.ativa).toBe(false);
      expect(repo.buscarPorHash('hash_r1')?.ativa).toBe(false);
      expect(repo.listarAtivas().map((chave) => chave.id)).toEqual(['key_r2']);
      expect(repo.listar()).toHaveLength(2);
      expect(repo.revogar('key_r1').ativa).toBe(false);
      expect(() => repo.revogar('key_inexistente')).toThrow(NotFoundError);
    } finally {
      limpar();
    }
  });

  it('registra o último uso', () => {
    const { banco, limpar } = criarBancoTemporario();
    try {
      const repo = new ApiKeysRepository(banco);
      repo.criar({ id: 'key_u', nome: 'Uso', keyHash: 'hash_u' });
      const usada = repo.registrarUso('key_u', '2026-03-01T10:00:00.000Z');
      expect(usada.ultimoUsoEm).toBe('2026-03-01T10:00:00.000Z');
      expect(() => repo.registrarUso('key_inexistente')).toThrow(NotFoundError);
    } finally {
      limpar();
    }
  });
});

describe('documentos', () => {
  it('insere, busca e lista por execução', () => {
    const temp = criarBancoTemporario();
    try {
      const { id } = criarChaveApi(temp.banco);
      temp.banco
        .prepare(
          "INSERT INTO execucoes (id, tipo, status, payload, payload_bruto, attempts, api_key_id, ticket, cache_version, criado_em) VALUES ('exe_doc', 'sefaz-bahia', 'SUCCESS', '{}', '{}', 0, ?, 1, 1, '2026-01-01T00:00:00.000Z')",
        )
        .run(id);
      const repo = new DocumentosRepository(temp.banco);
      const inserido = repo.inserir({
        id: 'doc_1',
        execucaoId: 'exe_doc',
        apiKeyId: id,
        tipo: 'print',
        caminho: 'exe_doc/print.jpg',
        contentType: 'image/jpeg',
        nomeArquivo: 'print.jpg',
        tamanhoBytes: 1024,
      });
      expect(inserido.tipo).toBe('print');
      expect(inserido.criadoEm).not.toBe('');
      expect(repo.buscarPorId('doc_1')?.caminho).toBe('exe_doc/print.jpg');
      expect(repo.buscarPorId('doc_inexistente')).toBeNull();
      expect(repo.listarPorExecucao('exe_doc')).toHaveLength(1);
      expect(repo.listarPorExecucao('exe_inexistente')).toEqual([]);
    } finally {
      temp.limpar();
    }
  });

  it('rejeita caminho absoluto, tipo inválido e execução inexistente', () => {
    const temp = criarBancoTemporario();
    try {
      const { id } = criarChaveApi(temp.banco);
      const repo = new DocumentosRepository(temp.banco);
      const base = {
        id: 'doc_ruim',
        execucaoId: 'exe_inexistente',
        apiKeyId: id,
        tipo: 'print',
        caminho: 'relativo/print.jpg',
        contentType: 'image/jpeg',
        nomeArquivo: 'print.jpg',
        tamanhoBytes: 10,
      };
      expect(() => repo.inserir({ ...base, caminho: '/absoluto/print.jpg' })).toThrow(
        ValidationError,
      );
      expect(() => repo.inserir({ ...base, tipo: 'video' })).toThrow(ValidationError);
      expect(() => repo.inserir({ ...base, contentType: 'video/mp4' })).toThrow(ValidationError);
      expect(() => repo.inserir({ ...base, tamanhoBytes: -1 })).toThrow(ValidationError);
      expect(() => repo.inserir(base)).toThrow(ValidationError);
      expect(() => repo.inserir({ ...base, id: 'doc_dup', execucaoId: 'exe_inexistente' })).toThrow(
        ValidationError,
      );
    } finally {
      temp.limpar();
    }
  });

  it('rejeita documento duplicado', () => {
    const temp = criarBancoTemporario();
    try {
      const { id } = criarChaveApi(temp.banco);
      temp.banco
        .prepare(
          "INSERT INTO execucoes (id, tipo, status, payload, payload_bruto, attempts, api_key_id, ticket, cache_version, criado_em) VALUES ('exe_doc2', 'sefaz-bahia', 'SUCCESS', '{}', '{}', 0, ?, 1, 1, '2026-01-01T00:00:00.000Z')",
        )
        .run(id);
      const repo = new DocumentosRepository(temp.banco);
      const entrada = {
        id: 'doc_2',
        execucaoId: 'exe_doc2',
        apiKeyId: id,
        tipo: 'pdf_pagina',
        caminho: 'exe_doc2/pagina.pdf',
        contentType: 'application/pdf',
        nomeArquivo: 'pagina.pdf',
        tamanhoBytes: 2048,
      };
      repo.inserir(entrada);
      expect(() => repo.inserir(entrada)).toThrow(ConflictError);
    } finally {
      temp.limpar();
    }
  });

  it('expira documentos antigos devolvendo os removidos', () => {
    const temp = criarBancoTemporario();
    try {
      const { id } = criarChaveApi(temp.banco);
      temp.banco
        .prepare(
          "INSERT INTO execucoes (id, tipo, status, payload, payload_bruto, attempts, api_key_id, ticket, cache_version, criado_em) VALUES ('exe_doc3', 'sefaz-bahia', 'SUCCESS', '{}', '{}', 0, ?, 1, 1, '2026-01-01T00:00:00.000Z')",
        )
        .run(id);
      const repo = new DocumentosRepository(temp.banco);
      repo.inserir({
        id: 'doc_velho',
        execucaoId: 'exe_doc3',
        apiKeyId: id,
        tipo: 'print',
        caminho: 'exe_doc3/velho.jpg',
        contentType: 'image/jpeg',
        nomeArquivo: 'velho.jpg',
        tamanhoBytes: 100,
        criadoEm: '2020-01-01T00:00:00.000Z',
      });
      repo.inserir({
        id: 'doc_novo',
        execucaoId: 'exe_doc3',
        apiKeyId: id,
        tipo: 'print',
        caminho: 'exe_doc3/novo.jpg',
        contentType: 'image/jpeg',
        nomeArquivo: 'novo.jpg',
        tamanhoBytes: 100,
        criadoEm: '2026-06-01T00:00:00.000Z',
      });
      const removidos = repo.removerExpirados('2021-01-01T00:00:00.000Z');
      expect(removidos.map((documento) => documento.id)).toEqual(['doc_velho']);
      expect(repo.buscarPorId('doc_velho')).toBeNull();
      expect(repo.buscarPorId('doc_novo')).not.toBeNull();
      expect(repo.removerExpirados('2021-01-01T00:00:00.000Z')).toEqual([]);
    } finally {
      temp.limpar();
    }
  });

  it('persiste expiraEm na inserção e devolve nulo quando ausente', () => {
    const temp = criarBancoTemporario();
    try {
      const { id } = criarChaveApi(temp.banco);
      temp.banco
        .prepare(
          "INSERT INTO execucoes (id, tipo, status, payload, payload_bruto, attempts, api_key_id, ticket, cache_version, criado_em) VALUES ('exe_exp', 'sefaz-bahia', 'SUCCESS', '{}', '{}', 0, ?, 1, 1, '2026-01-01T00:00:00.000Z')",
        )
        .run(id);
      const repo = new DocumentosRepository(temp.banco);
      const comExpiracao = repo.inserir({
        id: 'doc_com_expiracao',
        execucaoId: 'exe_exp',
        apiKeyId: id,
        tipo: 'print',
        caminho: 'exe_exp/com.jpg',
        contentType: 'image/jpeg',
        nomeArquivo: 'com.jpg',
        tamanhoBytes: 100,
        expiraEm: '2026-07-01T00:00:00.000Z',
      });
      expect(comExpiracao.expiraEm).toBe('2026-07-01T00:00:00.000Z');
      expect(repo.buscarPorId('doc_com_expiracao')?.expiraEm).toBe('2026-07-01T00:00:00.000Z');
      const semExpiracao = repo.inserir({
        id: 'doc_sem_expiracao',
        execucaoId: 'exe_exp',
        apiKeyId: id,
        tipo: 'print',
        caminho: 'exe_exp/sem.jpg',
        contentType: 'image/jpeg',
        nomeArquivo: 'sem.jpg',
        tamanhoBytes: 100,
      });
      expect(semExpiracao.expiraEm).toBeNull();
      expect(repo.buscarPorId('doc_sem_expiracao')?.expiraEm).toBeNull();
    } finally {
      temp.limpar();
    }
  });

  it('listarPorIds devolve na ordem pedida, ignora desconhecidos e aceita vazio', () => {
    const temp = criarBancoTemporario();
    try {
      const { id } = criarChaveApi(temp.banco);
      temp.banco
        .prepare(
          "INSERT INTO execucoes (id, tipo, status, payload, payload_bruto, attempts, api_key_id, ticket, cache_version, criado_em) VALUES ('exe_ids', 'sefaz-bahia', 'SUCCESS', '{}', '{}', 0, ?, 1, 1, '2026-01-01T00:00:00.000Z')",
        )
        .run(id);
      const repo = new DocumentosRepository(temp.banco);
      for (const docId of ['doc_a', 'doc_b', 'doc_c']) {
        repo.inserir({
          id: docId,
          execucaoId: 'exe_ids',
          apiKeyId: id,
          tipo: 'print',
          caminho: `exe_ids/${docId}.jpg`,
          contentType: 'image/jpeg',
          nomeArquivo: `${docId}.jpg`,
          tamanhoBytes: 10,
        });
      }
      expect(repo.listarPorIds([])).toEqual([]);
      expect(
        repo.listarPorIds(['doc_c', 'doc_a', 'doc_inexistente', 'doc_b']).map((doc) => doc.id),
      ).toEqual(['doc_c', 'doc_a', 'doc_b']);
      expect(repo.listarPorIds(['doc_inexistente'])).toEqual([]);
    } finally {
      temp.limpar();
    }
  });

  it('removerExpiradosEm remove apenas vencidos pela data exata', () => {
    const temp = criarBancoTemporario();
    try {
      const { id } = criarChaveApi(temp.banco);
      temp.banco
        .prepare(
          "INSERT INTO execucoes (id, tipo, status, payload, payload_bruto, attempts, api_key_id, ticket, cache_version, criado_em) VALUES ('exe_venc', 'sefaz-bahia', 'SUCCESS', '{}', '{}', 0, ?, 1, 1, '2026-01-01T00:00:00.000Z')",
        )
        .run(id);
      const repo = new DocumentosRepository(temp.banco);
      const base = {
        execucaoId: 'exe_venc',
        apiKeyId: id,
        tipo: 'print',
        contentType: 'image/jpeg',
        tamanhoBytes: 10,
      };
      repo.inserir({
        ...base,
        id: 'doc_passado',
        caminho: 'exe_venc/passado.jpg',
        nomeArquivo: 'passado.jpg',
        expiraEm: '2020-01-01T00:00:00.000Z',
      });
      repo.inserir({
        ...base,
        id: 'doc_futuro',
        caminho: 'exe_venc/futuro.jpg',
        nomeArquivo: 'futuro.jpg',
        expiraEm: '2999-01-01T00:00:00.000Z',
      });
      repo.inserir({
        ...base,
        id: 'doc_nulo',
        caminho: 'exe_venc/nulo.jpg',
        nomeArquivo: 'nulo.jpg',
      });
      const removidos = repo.removerExpiradosEm('2021-01-01T00:00:00.000Z');
      expect(removidos.map((documento) => documento.id)).toEqual(['doc_passado']);
      expect(repo.buscarPorId('doc_passado')).toBeNull();
      expect(repo.buscarPorId('doc_futuro')).not.toBeNull();
      expect(repo.buscarPorId('doc_nulo')).not.toBeNull();
      expect(repo.removerExpiradosEm('2021-01-01T00:00:00.000Z')).toEqual([]);
    } finally {
      temp.limpar();
    }
  });

  it('removerExpiradosLegados remove só documentos sem expira_em', () => {
    const temp = criarBancoTemporario();
    try {
      const { id } = criarChaveApi(temp.banco);
      temp.banco
        .prepare(
          "INSERT INTO execucoes (id, tipo, status, payload, payload_bruto, attempts, api_key_id, ticket, cache_version, criado_em) VALUES ('exe_leg', 'sefaz-bahia', 'SUCCESS', '{}', '{}', 0, ?, 1, 1, '2026-01-01T00:00:00.000Z')",
        )
        .run(id);
      const repo = new DocumentosRepository(temp.banco);
      const base = {
        execucaoId: 'exe_leg',
        apiKeyId: id,
        tipo: 'print',
        contentType: 'image/jpeg',
        tamanhoBytes: 10,
        criadoEm: '2020-01-01T00:00:00.000Z',
      };
      repo.inserir({ ...base, id: 'doc_legado', caminho: 'exe_leg/leg.jpg', nomeArquivo: 'leg.jpg' });
      repo.inserir({
        ...base,
        id: 'doc_com_expiracao',
        caminho: 'exe_leg/com.jpg',
        nomeArquivo: 'com.jpg',
        expiraEm: '2999-01-01T00:00:00.000Z',
      });
      const removidos = repo.removerExpiradosLegados('2021-01-01T00:00:00.000Z');
      expect(removidos.map((documento) => documento.id)).toEqual(['doc_legado']);
      expect(repo.buscarPorId('doc_com_expiracao')).not.toBeNull();
    } finally {
      temp.limpar();
    }
  });
});

describe('migração 003-documentos-expira-em', () => {
  it('aplica coluna expira_em e índice em banco novo', () => {
    const temp = criarBancoTemporario();
    try {
      const colunas = temp.banco
        .prepare<[], { name: string }>('PRAGMA table_info(documentos)')
        .all()
        .map((coluna) => coluna.name);
      expect(colunas).toContain('expira_em');
      const indices = temp.banco
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_documentos_expira_em'",
        )
        .all();
      expect(indices).toHaveLength(1);
      expect(listarMigrationsAplicadas(temp.banco)).toContain('003-documentos-expira-em');
    } finally {
      temp.limpar();
    }
  });

  it('migra banco legado com 001+002 preservando 7 dias de vida', () => {
    const diretorio = mkdtempSync(join(tmpdir(), 'migracao-legada-'));
    const banco = openDatabase(join(diretorio, 'legado.sqlite'));
    try {
      banco.exec(MIGRACAO_SCHEMA_INICIAL.sql);
      banco.exec(MIGRACAO_IDEMPOTENCY_KEY.sql);
      const aplicadoEm = new Date().toISOString();
      banco
        .prepare('INSERT INTO schema_migrations (nome, aplicado_em) VALUES (?, ?)')
        .run('001-schema-inicial', aplicadoEm);
      banco
        .prepare('INSERT INTO schema_migrations (nome, aplicado_em) VALUES (?, ?)')
        .run('002-idempotency-key', aplicadoEm);
      banco
        .prepare(
          "INSERT INTO api_keys (id, nome, key_hash, ativa, criada_em, ultimo_uso_em) VALUES ('key_legada', 'Legada', 'hash_legada', 1, '2026-01-01T00:00:00.000Z', NULL)",
        )
        .run();
      banco
        .prepare(
          "INSERT INTO execucoes (id, tipo, status, payload, payload_bruto, attempts, api_key_id, ticket, cache_version, criado_em) VALUES ('exe_legada', 'sefaz-bahia', 'SUCCESS', '{}', '{}', 0, 'key_legada', 1, 1, '2026-01-01T00:00:00.000Z')",
        )
        .run();
      banco
        .prepare(
          "INSERT INTO documentos (id, execucao_id, api_key_id, tipo, caminho, content_type, nome_arquivo, tamanho_bytes, criado_em) VALUES ('doc_legado', 'exe_legada', 'key_legada', 'print', 'exe_legada/legado.jpg', 'image/jpeg', 'legado.jpg', 100, '2026-01-01T00:00:00.000Z')",
        )
        .run();
      const novas = aplicarMigrations(banco);
      expect(novas).toEqual(['003-documentos-expira-em']);
      const linha = banco
        .prepare<[string], { expira_em: string | null }>(
          'SELECT expira_em FROM documentos WHERE id = ?',
        )
        .get('doc_legado');
      expect(linha).toBeDefined();
      expect(String(linha?.expira_em).startsWith('2026-01-08 00:00:00')).toBe(true);
      expect(listarMigrationsAplicadas(banco)).toEqual([
        '001-schema-inicial',
        '002-idempotency-key',
        '003-documentos-expira-em',
      ]);
    } finally {
      banco.close();
      rmSync(diretorio, { recursive: true, force: true });
    }
  });
});
