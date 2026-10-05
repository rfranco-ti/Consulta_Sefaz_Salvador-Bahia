import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { cacheConfig } from '../../src/config/cache.js';
import { CacheRepository } from '../../src/database/repositories/cache.repository.js';
import {
  CacheConsultas,
  montarChaveCache,
} from '../../src/modules/automation/automation.cache.js';
import { criarBancoTemporario } from './database-helpers.js';

const TIPO = 'sefaz-bahia' as const;

function criarRelogio(): { ler: () => number; avancar: (ms: number) => void } {
  let agora = Date.now();
  return {
    ler: () => agora,
    avancar: (ms: number) => {
      agora += ms;
    },
  };
}

function montar(parcial?: { versao?: number; capacidade?: number }): {
  banco: Database.Database;
  cache: CacheConsultas;
  repo: CacheRepository;
  relogio: { ler: () => number; avancar: (ms: number) => void };
  limpar: () => void;
} {
  const { banco, limpar } = criarBancoTemporario();
  const relogio = criarRelogio();
  const cache = new CacheConsultas({
    banco,
    agora: relogio.ler,
    versaoCache: () => parcial?.versao ?? 1,
    ...(parcial?.capacidade !== undefined ? { capacidadeMemoria: parcial.capacidade } : {}),
  });
  return { banco, cache, repo: new CacheRepository(banco), relogio, limpar };
}

describe('cache de consultas em duas camadas', () => {
  it('serve da memória na segunda chamada sem reexecutar', async () => {
    const { cache, limpar } = montar();
    try {
      let chamadas = 0;
      const executar = async (): Promise<Record<string, unknown>> => {
        chamadas += 1;
        return { situacao: 'ativa' };
      };
      const primeira = await cache.consultarComCache({ tipo: TIPO, payload: { cnpj: '123' }, executar });
      expect(primeira.cache.hit).toBe(false);
      expect(primeira.resultado).toEqual({ situacao: 'ativa' });
      const segunda = await cache.consultarComCache({ tipo: TIPO, payload: { cnpj: '123' }, executar });
      expect(segunda.cache).toMatchObject({ hit: true, camada: 'memoria' });
      expect(segunda.resultado).toEqual({ situacao: 'ativa' });
      expect(segunda.cache.ttlRestanteSeg).toBeGreaterThan(0);
      expect(chamadas).toBe(1);
    } finally {
      limpar();
    }
  });

  it('recupera do SQLite em instância nova e repopula a memória', async () => {
    const { banco, relogio, limpar } = montar();
    try {
      const primeira = new CacheConsultas({ banco, agora: relogio.ler, versaoCache: () => 1 });
      await primeira.consultarComCache({
        tipo: TIPO,
        payload: { inscricao: '456' },
        executar: async () => ({ situacao: 'ativa' }),
      });
      const segunda = new CacheConsultas({ banco, agora: relogio.ler, versaoCache: () => 1 });
      expect(segunda.tamanhoMemoria()).toBe(0);
      let chamadas = 0;
      const saida = await segunda.consultarComCache({
        tipo: TIPO,
        payload: { inscricao: '456' },
        executar: async (): Promise<Record<string, unknown>> => {
          chamadas += 1;
          return { situacao: 'ativa' };
        },
      });
      expect(saida.cache).toMatchObject({ hit: true, camada: 'sqlite' });
      expect(saida.resultado).toEqual({ situacao: 'ativa' });
      expect(chamadas).toBe(0);
      expect(segunda.tamanhoMemoria()).toBe(1);
      const terceira = await segunda.consultarComCache({
        tipo: TIPO,
        payload: { inscricao: '456' },
        executar: async (): Promise<Record<string, unknown>> => {
          chamadas += 1;
          return { situacao: 'ativa' };
        },
      });
      expect(terceira.cache).toMatchObject({ hit: true, camada: 'memoria' });
      expect(chamadas).toBe(0);
    } finally {
      limpar();
    }
  });

  it('executa quando não há nada em cache e persiste nas duas camadas', async () => {
    const { cache, repo, limpar } = montar();
    try {
      const payload = { cnpj: '789' };
      const chave = montarChaveCache(TIPO, payload);
      expect(repo.obter(chave)).toBeNull();
      const saida = await cache.consultarComCache({
        tipo: TIPO,
        payload,
        executar: async () => ({ situacao: 'ativa' }),
      });
      expect(saida.cache.hit).toBe(false);
      expect(repo.obter(chave)?.dados).toBe(JSON.stringify({ situacao: 'ativa' }));
      expect(cache.tamanhoMemoria()).toBe(1);
    } finally {
      limpar();
    }
  });

  it('expira nas duas camadas quando o TTL passa', async () => {
    const { banco, relogio, limpar } = montar();
    try {
      const cache = new CacheConsultas({ banco, agora: relogio.ler, versaoCache: () => 1 });
      let chamadas = 0;
      const executar = async (): Promise<Record<string, unknown>> => {
        chamadas += 1;
        return { situacao: 'ativa' };
      };
      await cache.consultarComCache({ tipo: TIPO, payload: { cnpj: '123' }, executar });
      expect(chamadas).toBe(1);
      relogio.avancar(cacheConfig(TIPO).ttlMs + 1000);
      const vencidaMemoria = await cache.consultarComCache({
        tipo: TIPO,
        payload: { cnpj: '123' },
        executar,
      });
      expect(vencidaMemoria.cache.hit).toBe(false);
      expect(chamadas).toBe(2);
      const fria = new CacheConsultas({ banco, agora: relogio.ler, versaoCache: () => 1 });
      const vencidaSqlite = await fria.consultarComCache({
        tipo: TIPO,
        payload: { cnpj: '123' },
        executar,
      });
      expect(vencidaSqlite.cache.hit).toBe(false);
      expect(chamadas).toBe(3);
    } finally {
      limpar();
    }
  });

  it('invalida entradas antigas quando a versão muda', async () => {
    const { banco, relogio, limpar } = montar();
    try {
      const repo = new CacheRepository(banco);
      const v1 = new CacheConsultas({ banco, agora: relogio.ler, versaoCache: () => 1 });
      await v1.consultarComCache({
        tipo: TIPO,
        payload: { id: 'A' },
        executar: async () => ({ situacao: 'antiga' }),
      });
      await v1.consultarComCache({
        tipo: TIPO,
        payload: { id: 'B' },
        executar: async () => ({ situacao: 'antiga' }),
      });
      const chaveB = montarChaveCache(TIPO, { id: 'B' });
      expect(repo.obter(chaveB)).not.toBeNull();
      const v2 = new CacheConsultas({ banco, agora: relogio.ler, versaoCache: () => 2 });
      let chamadas = 0;
      const saida = await v2.consultarComCache({
        tipo: TIPO,
        payload: { id: 'A' },
        executar: async (): Promise<Record<string, unknown>> => {
          chamadas += 1;
          return { situacao: 'nova' };
        },
      });
      expect(saida.cache.hit).toBe(false);
      expect(saida.resultado).toEqual({ situacao: 'nova' });
      expect(chamadas).toBe(1);
      expect(repo.obter(chaveB)).toBeNull();
      expect(repo.obter(montarChaveCache(TIPO, { id: 'A' }))?.cacheVersion).toBe(2);
    } finally {
      limpar();
    }
  });

  it('forceRefresh pula o cache, executa e regrava', async () => {
    const { cache, limpar } = montar();
    try {
      let dado = 'ativa';
      let chamadas = 0;
      const executar = async (): Promise<Record<string, unknown>> => {
        chamadas += 1;
        return { situacao: dado };
      };
      await cache.consultarComCache({ tipo: TIPO, payload: { cnpj: '123' }, executar });
      expect(chamadas).toBe(1);
      dado = 'baixada';
      const recarregada = await cache.consultarComCache({
        tipo: TIPO,
        payload: { cnpj: '123' },
        forceRefresh: true,
        executar,
      });
      expect(recarregada.cache.hit).toBe(false);
      expect(recarregada.resultado).toEqual({ situacao: 'baixada' });
      expect(chamadas).toBe(2);
      const depois = await cache.consultarComCache({ tipo: TIPO, payload: { cnpj: '123' }, executar });
      expect(depois.cache).toMatchObject({ hit: true });
      expect(depois.resultado).toEqual({ situacao: 'baixada' });
      expect(chamadas).toBe(2);
    } finally {
      limpar();
    }
  });

  it('usa o padrão do tipo quando forceRefresh não é informado', async () => {
    const { cache, limpar } = montar();
    try {
      expect(cacheConfig(TIPO).forceRefreshDefault).toBe(false);
      await cache.consultarComCache({
        tipo: TIPO,
        payload: { cnpj: '123' },
        executar: async () => ({ situacao: 'ativa' }),
      });
      let chamadas = 0;
      const saida = await cache.consultarComCache({
        tipo: TIPO,
        payload: { cnpj: '123' },
        executar: async (): Promise<Record<string, unknown>> => {
          chamadas += 1;
          return { situacao: 'ativa' };
        },
      });
      expect(saida.cache.hit).toBe(true);
      expect(chamadas).toBe(0);
    } finally {
      limpar();
    }
  });

  it('não grava falha no cache e permite nova tentativa', async () => {
    const { cache, repo, limpar } = montar();
    try {
      const payload = { cnpj: '123' };
      let tentativas = 0;
      const executar = async (): Promise<Record<string, unknown>> => {
        tentativas += 1;
        if (tentativas === 1) {
          throw new Error('Portal fora do ar');
        }
        return { situacao: 'ativa' };
      };
      await expect(cache.consultarComCache({ tipo: TIPO, payload, executar })).rejects.toThrow(
        'Portal fora do ar',
      );
      expect(repo.obter(montarChaveCache(TIPO, payload))).toBeNull();
      expect(cache.tamanhoMemoria()).toBe(0);
      const saida = await cache.consultarComCache({ tipo: TIPO, payload, executar });
      expect(saida.cache.hit).toBe(false);
      expect(saida.resultado).toEqual({ situacao: 'ativa' });
      expect(tentativas).toBe(2);
    } finally {
      limpar();
    }
  });

  it('gera a mesma chave independente da ordem das chaves do payload', () => {
    const a = montarChaveCache(TIPO, { b: 2, a: 1, aninhado: { y: 1, x: 2 } });
    const b = montarChaveCache(TIPO, { a: 1, b: 2, aninhado: { x: 2, y: 1 } });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(montarChaveCache(TIPO, { a: 1 })).not.toBe(montarChaveCache(TIPO, { a: 2 }));
    expect(montarChaveCache(TIPO, { a: 1 })).not.toBe(montarChaveCache('cadin-salvador', { a: 1 }));
  });

  it('despeja a entrada mais antiga da memória ao lotar sem perder o SQLite', async () => {
    const { cache, limpar } = montar({ capacidade: 2 });
    try {
      const executar = async (): Promise<Record<string, unknown>> => ({ situacao: 'ativa' });
      await cache.consultarComCache({ tipo: TIPO, payload: { id: 'A' }, executar });
      await cache.consultarComCache({ tipo: TIPO, payload: { id: 'B' }, executar });
      await cache.consultarComCache({ tipo: TIPO, payload: { id: 'C' }, executar });
      expect(cache.tamanhoMemoria()).toBe(2);
      let chamadas = 0;
      const saida = await cache.consultarComCache({
        tipo: TIPO,
        payload: { id: 'A' },
        executar: async (): Promise<Record<string, unknown>> => {
          chamadas += 1;
          return { situacao: 'ativa' };
        },
      });
      expect(saida.cache).toMatchObject({ hit: true, camada: 'sqlite' });
      expect(chamadas).toBe(0);
    } finally {
      limpar();
    }
  });

  it('invalidarTipo limpa as duas camadas só do tipo pedido', async () => {
    const { cache, repo, limpar } = montar();
    try {
      const executar = async (): Promise<Record<string, unknown>> => ({ situacao: 'ativa' });
      await cache.consultarComCache({ tipo: TIPO, payload: { id: 'A' }, executar });
      await cache.consultarComCache({ tipo: 'cadin-salvador', payload: { id: 'A' }, executar });
      expect(cache.tamanhoMemoria()).toBe(2);
      cache.invalidarTipo(TIPO);
      expect(cache.tamanhoMemoria()).toBe(1);
      expect(repo.obter(montarChaveCache(TIPO, { id: 'A' }))).toBeNull();
      expect(repo.obter(montarChaveCache('cadin-salvador', { id: 'A' }))).not.toBeNull();
    } finally {
      limpar();
    }
  });
});
