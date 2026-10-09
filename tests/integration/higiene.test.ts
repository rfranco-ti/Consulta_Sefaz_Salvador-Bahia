import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { CacheRepository } from '../../src/database/repositories/cache.repository.js';
import { DocumentosRepository } from '../../src/database/repositories/documentos.repository.js';
import {
  caminhoBancoAbsoluto,
  diretorioArmazenamentoAbsoluto,
  env,
} from '../../src/config/env.js';
import {
  executarHigiene,
  higieneAtiva,
  iniciarHigiene,
  pararHigiene,
} from '../../src/modules/higiene/index.js';
import { criarBancoTemporario, criarChaveApi, criarExecucaoPendente } from './database-helpers.js';

const DADOS = '{"situacao":"ativa"}';
const AGORA = new Date('2026-06-15T12:00:00.000Z');
const TTL_DIAS = 7;

const loggerSilencioso = pino({ level: 'silent' });

function criarArmazenamento(): { diretorio: string; limpar: () => void } {
  const diretorio = mkdtempSync(join(tmpdir(), 'higiene-storage-'));
  return {
    diretorio,
    limpar: () => {
      rmSync(diretorio, { recursive: true, force: true });
    },
  };
}

function semearCache(banco: Database.Database): CacheRepository {
  const repo = new CacheRepository(banco);
  repo.salvar({ chave: 'chave_velha', tipo: 'sefaz-bahia', dados: DADOS, cacheVersion: 1, ttlMs: 60_000 });
  repo.salvar({ chave: 'chave_nova', tipo: 'sefaz-bahia', dados: DADOS, cacheVersion: 1, ttlMs: 3_600_000 });
  banco
    .prepare<[string, string]>('UPDATE cache_consultas SET expira_em = ? WHERE chave = ?')
    .run('2020-01-01T00:00:00.000Z', 'chave_velha');
  return repo;
}

function semearDocumento(
  banco: Database.Database,
  armazenamento: string,
  parcial: {
    docId: string;
    execId: string;
    apiKeyId: string;
    nome: string;
    criadoEm: string;
    expiraEm?: string | null;
  },
): void {
  criarExecucaoPendente(banco, { id: parcial.execId, apiKeyId: parcial.apiKeyId });
  mkdirSync(join(armazenamento, parcial.execId), { recursive: true });
  writeFileSync(join(armazenamento, parcial.execId, parcial.nome), 'conteudo de teste');
  new DocumentosRepository(banco).inserir({
    id: parcial.docId,
    execucaoId: parcial.execId,
    apiKeyId: parcial.apiKeyId,
    tipo: 'print',
    caminho: `${parcial.execId}/${parcial.nome}`,
    contentType: 'image/jpeg',
    nomeArquivo: parcial.nome,
    tamanhoBytes: 18,
    criadoEm: parcial.criadoEm,
    expiraEm: parcial.expiraEm ?? null,
  });
}

describe('higiene', () => {
  it('remove cache expirado e mantém o vigente', () => {
    const temp = criarBancoTemporario();
    const storage = criarArmazenamento();
    try {
      const repo = semearCache(temp.banco);
      const resumo = executarHigiene({
        banco: temp.banco,
        diretorioArmazenamento: storage.diretorio,
        ttlDiasDocumentos: TTL_DIAS,
        agora: () => AGORA,
      });
      expect(resumo.cacheRemovido).toBe(1);
      expect(resumo.documentosRemovidos).toBe(0);
      expect(repo.obter('chave_velha')).toBeNull();
      expect(repo.obter('chave_nova')).not.toBeNull();
    } finally {
      storage.limpar();
      temp.limpar();
    }
  });

  it('remove documentos antigos com arquivos e mantém os recentes', () => {
    const temp = criarBancoTemporario();
    const storage = criarArmazenamento();
    try {
      const { id } = criarChaveApi(temp.banco);
      semearDocumento(temp.banco, storage.diretorio, {
        docId: 'doc_velho',
        execId: 'exe_velha',
        apiKeyId: id,
        nome: 'velho.jpg',
        criadoEm: '2026-01-01T00:00:00.000Z',
      });
      semearDocumento(temp.banco, storage.diretorio, {
        docId: 'doc_novo',
        execId: 'exe_nova',
        apiKeyId: id,
        nome: 'novo.jpg',
        criadoEm: '2026-06-14T00:00:00.000Z',
      });
      const resumo = executarHigiene({
        banco: temp.banco,
        diretorioArmazenamento: storage.diretorio,
        ttlDiasDocumentos: TTL_DIAS,
        agora: () => AGORA,
      });
      expect(resumo).toEqual({
        cacheRemovido: 0,
        documentosRemovidos: 1,
        arquivosRemovidos: 1,
        arquivosAusentes: 0,
      });
      const repo = new DocumentosRepository(temp.banco);
      expect(repo.buscarPorId('doc_velho')).toBeNull();
      expect(repo.buscarPorId('doc_novo')).not.toBeNull();
      expect(existsSync(join(storage.diretorio, 'exe_velha', 'velho.jpg'))).toBe(false);
      expect(existsSync(join(storage.diretorio, 'exe_nova', 'novo.jpg'))).toBe(true);
    } finally {
      storage.limpar();
      temp.limpar();
    }
  });

  it('conta arquivo já ausente e remove diretório vazio preservando o não vazio', () => {
    const temp = criarBancoTemporario();
    const storage = criarArmazenamento();
    try {
      const { id } = criarChaveApi(temp.banco);
      criarExecucaoPendente(temp.banco, { id: 'exe_ausente', apiKeyId: id });
      mkdirSync(join(storage.diretorio, 'exe_ausente'), { recursive: true });
      new DocumentosRepository(temp.banco).inserir({
        id: 'doc_ausente',
        execucaoId: 'exe_ausente',
        apiKeyId: id,
        tipo: 'print',
        caminho: 'exe_ausente/ausente.jpg',
        contentType: 'image/jpeg',
        nomeArquivo: 'ausente.jpg',
        tamanhoBytes: 10,
        criadoEm: '2026-01-01T00:00:00.000Z',
      });
      criarExecucaoPendente(temp.banco, { id: 'exe_mista', apiKeyId: id });
      mkdirSync(join(storage.diretorio, 'exe_mista'), { recursive: true });
      writeFileSync(join(storage.diretorio, 'exe_mista', 'velho.jpg'), 'conteudo de teste');
      writeFileSync(join(storage.diretorio, 'exe_mista', 'avulso.jpg'), 'arquivo fora do banco');
      new DocumentosRepository(temp.banco).inserir({
        id: 'doc_misto',
        execucaoId: 'exe_mista',
        apiKeyId: id,
        tipo: 'print',
        caminho: 'exe_mista/velho.jpg',
        contentType: 'image/jpeg',
        nomeArquivo: 'velho.jpg',
        tamanhoBytes: 10,
        criadoEm: '2026-01-01T00:00:00.000Z',
      });
      const resumo = executarHigiene({
        banco: temp.banco,
        diretorioArmazenamento: storage.diretorio,
        ttlDiasDocumentos: TTL_DIAS,
        agora: () => AGORA,
      });
      expect(resumo.documentosRemovidos).toBe(2);
      expect(resumo.arquivosRemovidos).toBe(1);
      expect(resumo.arquivosAusentes).toBe(1);
      expect(existsSync(join(storage.diretorio, 'exe_ausente'))).toBe(false);
      expect(existsSync(join(storage.diretorio, 'exe_mista', 'velho.jpg'))).toBe(false);
      expect(existsSync(join(storage.diretorio, 'exe_mista', 'avulso.jpg'))).toBe(true);
      expect(existsSync(join(storage.diretorio, 'exe_mista'))).toBe(true);
    } finally {
      storage.limpar();
      temp.limpar();
    }
  });

  it('retorna resumo zerado quando nada expirou', () => {
    const temp = criarBancoTemporario();
    const storage = criarArmazenamento();
    try {
      const repo = new CacheRepository(temp.banco);
      repo.salvar({ chave: 'chave_vigente', tipo: 'sefaz-bahia', dados: DADOS, cacheVersion: 1, ttlMs: 3_600_000 });
      const resumo = executarHigiene({
        banco: temp.banco,
        diretorioArmazenamento: storage.diretorio,
        ttlDiasDocumentos: TTL_DIAS,
        agora: () => AGORA,
      });
      expect(resumo).toEqual({
        cacheRemovido: 0,
        documentosRemovidos: 0,
        arquivosRemovidos: 0,
        arquivosAusentes: 0,
      });
    } finally {
      storage.limpar();
      temp.limpar();
    }
  });

  it('remove documentos pela expira_em exata e preserva os vigentes', () => {
    const temp = criarBancoTemporario();
    const storage = criarArmazenamento();
    try {
      const { id } = criarChaveApi(temp.banco);
      semearDocumento(temp.banco, storage.diretorio, {
        docId: 'doc_expirado',
        execId: 'exe_expirada',
        apiKeyId: id,
        nome: 'expirado.jpg',
        criadoEm: '2026-06-14T00:00:00.000Z',
        expiraEm: '2026-06-15T11:59:59.000Z',
      });
      semearDocumento(temp.banco, storage.diretorio, {
        docId: 'doc_vigente',
        execId: 'exe_vigente',
        apiKeyId: id,
        nome: 'vigente.jpg',
        criadoEm: '2026-01-01T00:00:00.000Z',
        expiraEm: '2026-06-15T12:00:01.000Z',
      });
      const resumo = executarHigiene({
        banco: temp.banco,
        diretorioArmazenamento: storage.diretorio,
        ttlDiasDocumentos: TTL_DIAS,
        agora: () => AGORA,
      });
      expect(resumo.documentosRemovidos).toBe(1);
      expect(resumo.arquivosRemovidos).toBe(1);
      expect(resumo.arquivosAusentes).toBe(0);
      const repo = new DocumentosRepository(temp.banco);
      expect(repo.buscarPorId('doc_expirado')).toBeNull();
      expect(repo.buscarPorId('doc_vigente')).not.toBeNull();
      expect(existsSync(join(storage.diretorio, 'exe_expirada', 'expirado.jpg'))).toBe(false);
      expect(existsSync(join(storage.diretorio, 'exe_vigente', 'vigente.jpg'))).toBe(true);
    } finally {
      storage.limpar();
      temp.limpar();
    }
  });

  it('remove documentos legados sem expira_em pela regra de idade', () => {
    const temp = criarBancoTemporario();
    const storage = criarArmazenamento();
    try {
      const { id } = criarChaveApi(temp.banco);
      semearDocumento(temp.banco, storage.diretorio, {
        docId: 'doc_legado',
        execId: 'exe_legada',
        apiKeyId: id,
        nome: 'legado.jpg',
        criadoEm: '2026-01-01T00:00:00.000Z',
        expiraEm: null,
      });
      expect(new DocumentosRepository(temp.banco).buscarPorId('doc_legado')?.expiraEm).toBeNull();
      const resumo = executarHigiene({
        banco: temp.banco,
        diretorioArmazenamento: storage.diretorio,
        ttlDiasDocumentos: TTL_DIAS,
        agora: () => AGORA,
      });
      expect(resumo.documentosRemovidos).toBe(1);
      expect(resumo.arquivosRemovidos).toBe(1);
      expect(new DocumentosRepository(temp.banco).buscarPorId('doc_legado')).toBeNull();
      expect(existsSync(join(storage.diretorio, 'exe_legada', 'legado.jpg'))).toBe(false);
    } finally {
      storage.limpar();
      temp.limpar();
    }
  });

  it('limpezas de cache e de documentos sao independentes', () => {
    const temp = criarBancoTemporario();
    const storage = criarArmazenamento();
    try {
      const { id } = criarChaveApi(temp.banco);
      const cache = semearCache(temp.banco);
      semearDocumento(temp.banco, storage.diretorio, {
        docId: 'doc_vigente',
        execId: 'exe_vigente',
        apiKeyId: id,
        nome: 'vigente.jpg',
        criadoEm: '2026-06-14T00:00:00.000Z',
        expiraEm: '2026-07-01T00:00:00.000Z',
      });
      const primeira = executarHigiene({
        banco: temp.banco,
        diretorioArmazenamento: storage.diretorio,
        ttlDiasDocumentos: TTL_DIAS,
        agora: () => AGORA,
      });
      expect(primeira.cacheRemovido).toBe(1);
      expect(primeira.documentosRemovidos).toBe(0);
      expect(cache.obter('chave_velha')).toBeNull();
      expect(new DocumentosRepository(temp.banco).buscarPorId('doc_vigente')).not.toBeNull();

      semearDocumento(temp.banco, storage.diretorio, {
        docId: 'doc_expirado',
        execId: 'exe_expirada',
        apiKeyId: id,
        nome: 'expirado.jpg',
        criadoEm: '2026-06-14T00:00:00.000Z',
        expiraEm: '2026-06-01T00:00:00.000Z',
      });
      const segunda = executarHigiene({
        banco: temp.banco,
        diretorioArmazenamento: storage.diretorio,
        ttlDiasDocumentos: TTL_DIAS,
        agora: () => AGORA,
      });
      expect(segunda.cacheRemovido).toBe(0);
      expect(segunda.documentosRemovidos).toBe(1);
      expect(cache.obter('chave_nova')).not.toBeNull();
      expect(new DocumentosRepository(temp.banco).buscarPorId('doc_expirado')).toBeNull();
    } finally {
      storage.limpar();
      temp.limpar();
    }
  });

  it('resolve caminhos absolutos ancorados na raiz do projeto', () => {
    const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const bancoAntes = caminhoBancoAbsoluto();
    const armazenamentoAntes = diretorioArmazenamentoAbsoluto();
    expect(isAbsolute(bancoAntes)).toBe(true);
    expect(isAbsolute(armazenamentoAntes)).toBe(true);
    if (env.DATABASE_PATH !== ':memory:') {
      expect(bancoAntes).toBe(resolve(raiz, env.DATABASE_PATH));
    }
    expect(armazenamentoAntes).toBe(resolve(raiz, env.STORAGE_DIR));
    const original = process.cwd();
    const outro = mkdtempSync(join(tmpdir(), 'higiene-cwd-'));
    try {
      process.chdir(outro);
      expect(caminhoBancoAbsoluto()).toBe(bancoAntes);
      expect(diretorioArmazenamentoAbsoluto()).toBe(armazenamentoAntes);
    } finally {
      process.chdir(original);
      rmSync(outro, { recursive: true, force: true });
    }
  });

  it('iniciar e parar controlam o temporizador sem vazar', () => {
    const temp = criarBancoTemporario();
    const storage = criarArmazenamento();
    try {
      expect(higieneAtiva()).toBe(false);
      iniciarHigiene({
        banco: temp.banco,
        diretorioArmazenamento: storage.diretorio,
        ttlDiasDocumentos: TTL_DIAS,
        intervaloMin: 60,
        executarNaPartida: false,
        logger: loggerSilencioso,
      });
      expect(higieneAtiva()).toBe(true);
      iniciarHigiene({
        banco: temp.banco,
        diretorioArmazenamento: storage.diretorio,
        ttlDiasDocumentos: TTL_DIAS,
        intervaloMin: 60,
        executarNaPartida: false,
        logger: loggerSilencioso,
      });
      expect(higieneAtiva()).toBe(true);
      pararHigiene();
      expect(higieneAtiva()).toBe(false);
      pararHigiene();
      expect(higieneAtiva()).toBe(false);
    } finally {
      pararHigiene();
      storage.limpar();
      temp.limpar();
    }
  });

  it('executa uma vez na partida quando solicitado', () => {
    const temp = criarBancoTemporario();
    const storage = criarArmazenamento();
    try {
      semearCache(temp.banco);
      iniciarHigiene({
        banco: temp.banco,
        diretorioArmazenamento: storage.diretorio,
        ttlDiasDocumentos: TTL_DIAS,
        intervaloMin: 60,
        executarNaPartida: true,
        logger: loggerSilencioso,
      });
      try {
        expect(higieneAtiva()).toBe(true);
        expect(new CacheRepository(temp.banco).obter('chave_velha')).toBeNull();
      } finally {
        pararHigiene();
      }
    } finally {
      storage.limpar();
      temp.limpar();
    }
  });
});
