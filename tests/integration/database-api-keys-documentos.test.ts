import { describe, expect, it } from 'vitest';
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
});
