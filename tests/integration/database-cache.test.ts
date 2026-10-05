import { describe, expect, it } from 'vitest';
import { CacheRepository } from '../../src/database/repositories/cache.repository.js';
import { ValidationError } from '../../src/shared/errors/index.js';
import { criarBancoTemporario } from './database-helpers.js';

const DADOS = '{"situacao":"ativa"}';

function montar(): { repo: CacheRepository; limpar: () => void } {
  const { banco, limpar } = criarBancoTemporario();
  return { repo: new CacheRepository(banco), limpar };
}

describe('cache de consultas', () => {
  it('grava e lê com validade', () => {
    const { repo, limpar } = montar();
    try {
      const entrada = repo.salvar({
        chave: 'chave_1',
        tipo: 'sefaz-bahia',
        dados: DADOS,
        cacheVersion: 1,
        ttlMs: 60_000,
      });
      expect(entrada.tamanhoBytes).toBeGreaterThan(0);
      const lida = repo.obter('chave_1');
      expect(lida?.dados).toBe(DADOS);
      expect(lida?.tipo).toBe('sefaz-bahia');
      expect(lida?.cacheVersion).toBe(1);
    } finally {
      limpar();
    }
  });

  it('retorna nulo para chave inexistente', () => {
    const { repo, limpar } = montar();
    try {
      expect(repo.obter('chave_inexistente')).toBeNull();
    } finally {
      limpar();
    }
  });

  it('expirado não é retornado', () => {
    const { repo, limpar } = montar();
    try {
      repo.salvar({ chave: 'chave_exp', tipo: 'sefaz-bahia', dados: DADOS, cacheVersion: 1, ttlMs: 60_000 });
      const futuro = new Date(Date.now() + 120_000).toISOString();
      expect(repo.obter('chave_exp', futuro)).toBeNull();
      expect(repo.obter('chave_exp')).not.toBeNull();
    } finally {
      limpar();
    }
  });

  it('recusa dado inválido e não armazena nada', () => {
    const { repo, limpar } = montar();
    try {
      expect(() =>
        repo.salvar({ chave: 'chave_vazia', tipo: 'sefaz-bahia', dados: '', cacheVersion: 1, ttlMs: 60_000 }),
      ).toThrow(ValidationError);
      expect(() =>
        repo.salvar({ chave: 'chave_quebrada', tipo: 'sefaz-bahia', dados: '{invalido', cacheVersion: 1, ttlMs: 60_000 }),
      ).toThrow(ValidationError);
      expect(() =>
        repo.salvar({ chave: 'chave_tipo', tipo: 'portal-inexistente', dados: DADOS, cacheVersion: 1, ttlMs: 60_000 }),
      ).toThrow(ValidationError);
      expect(repo.obter('chave_vazia')).toBeNull();
      expect(repo.obter('chave_quebrada')).toBeNull();
    } finally {
      limpar();
    }
  });

  it('sobrescreve a mesma chave ao regravar', () => {
    const { repo, limpar } = montar();
    try {
      repo.salvar({ chave: 'chave_dup', tipo: 'sefaz-bahia', dados: DADOS, cacheVersion: 1, ttlMs: 60_000 });
      repo.salvar({ chave: 'chave_dup', tipo: 'sefaz-bahia', dados: '{"situacao":"baixada"}', cacheVersion: 1, ttlMs: 60_000 });
      expect(repo.obter('chave_dup')?.dados).toBe('{"situacao":"baixada"}');
    } finally {
      limpar();
    }
  });

  it('invalida por tipo sem afetar outros tipos', () => {
    const { repo, limpar } = montar();
    try {
      repo.salvar({ chave: 'chave_a', tipo: 'sefaz-bahia', dados: DADOS, cacheVersion: 1, ttlMs: 60_000 });
      repo.salvar({ chave: 'chave_b', tipo: 'cadin-salvador', dados: DADOS, cacheVersion: 1, ttlMs: 60_000 });
      expect(repo.invalidarTipo('sefaz-bahia')).toBe(1);
      expect(repo.obter('chave_a')).toBeNull();
      expect(repo.obter('chave_b')).not.toBeNull();
      expect(repo.invalidarTipo('tipo-sem-entradas')).toBe(0);
    } finally {
      limpar();
    }
  });

  it('invalida versões anteriores mantendo a atual', () => {
    const { repo, limpar } = montar();
    try {
      repo.salvar({ chave: 'chave_v1', tipo: 'sefaz-bahia', dados: DADOS, cacheVersion: 1, ttlMs: 60_000 });
      repo.salvar({ chave: 'chave_v2', tipo: 'sefaz-bahia', dados: DADOS, cacheVersion: 2, ttlMs: 60_000 });
      expect(repo.invalidarVersoesAnteriores('sefaz-bahia', 2)).toBe(1);
      expect(repo.obter('chave_v1')).toBeNull();
      expect(repo.obter('chave_v2')).not.toBeNull();
    } finally {
      limpar();
    }
  });

  it('remove expirados na higiene', () => {
    const { repo, limpar } = montar();
    try {
      repo.salvar({ chave: 'chave_velha', tipo: 'sefaz-bahia', dados: DADOS, cacheVersion: 1, ttlMs: 60_000 });
      repo.salvar({ chave: 'chave_nova', tipo: 'sefaz-bahia', dados: DADOS, cacheVersion: 1, ttlMs: 3_600_000 });
      const futuro = new Date(Date.now() + 120_000).toISOString();
      expect(repo.removerExpirados(futuro)).toBe(1);
      expect(repo.obter('chave_velha')).toBeNull();
      expect(repo.obter('chave_nova')).not.toBeNull();
    } finally {
      limpar();
    }
  });
});
