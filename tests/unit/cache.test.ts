import { describe, expect, it } from 'vitest';
import { cacheConfig, parseDuracao } from '../../src/config/cache.js';

describe('configuracao de cache', () => {
  it('DAM tem TTL de 12h e forceRefresh desligado por padrao', () => {
    expect(cacheConfig('dam-tff-tll').ttlMs).toBe(12 * 60 * 60 * 1000);
    expect(cacheConfig('dam-tff-tll').forceRefreshDefault).toBe(false);
  });

  it('consultas cadastrais usam 7 dias', () => {
    expect(cacheConfig('ficha-cadastral').ttlMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(cacheConfig('sefaz-bahia').ttlMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('CADIN usa 3 dias', () => {
    expect(cacheConfig('cadin-salvador').ttlMs).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it('parseDuracao aceita 30s, 45m, 12h, 7d', () => {
    expect(parseDuracao('30s')).toBe(30_000);
    expect(parseDuracao('45m')).toBe(45 * 60_000);
    expect(parseDuracao('12h')).toBe(12 * 3_600_000);
    expect(parseDuracao('7d')).toBe(7 * 86_400_000);
  });

  it('parseDuracao rejeita formato invalido', () => {
    expect(() => parseDuracao('7x')).toThrow(/Duracao invalida/);
    expect(() => parseDuracao('amanha')).toThrow(/Duracao invalida/);
  });
});
