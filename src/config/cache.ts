import { env } from './env.js';
import type { TipoAutomacao } from '../automations/registry.js';

/**
 * TTL de cache por tipo de automacao (.docs/JOBS.md, DECISIONS.md D0004).
 *
 * Override por ambiente: CACHE_<TIPO_EM_SNAKE> no .env
 *   ex.: CACHE_SEFAZ_BAHIA=14d   CACHE_DAM_TFF_TLL=24h
 *
 * Formato aceito: `30s`, `45m`, `12h`, `7d`.
 */

const SEGUNDO = 1000;
const MINUTO = 60 * SEGUNDO;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;

export interface CacheConfig {
  ttlMs: number;
  /** DAM: quase toda emissao pede estado atual (DECISIONS.md D0004). */
  forceRefreshDefault: boolean;
}

const PADRAO: Record<TipoAutomacao, CacheConfig> = {
  'sefaz-bahia': { ttlMs: 7 * DIA, forceRefreshDefault: false },
  'sefaz-bahia-inscricao': { ttlMs: 7 * DIA, forceRefreshDefault: false },
  'sefaz-bahia-socio': { ttlMs: 7 * DIA, forceRefreshDefault: false },
  'consulta-inscricoes': { ttlMs: 7 * DIA, forceRefreshDefault: false },
  'iptu-salvador': { ttlMs: 7 * DIA, forceRefreshDefault: false },
  'ficha-cadastral': { ttlMs: 7 * DIA, forceRefreshDefault: false },
  'alvara-funcionamento': { ttlMs: 7 * DIA, forceRefreshDefault: false },
  'cadin-salvador': { ttlMs: 3 * DIA, forceRefreshDefault: false },
  'dam-tff-tll': { ttlMs: 12 * HORA, forceRefreshDefault: true },
  'dam-tll': { ttlMs: 12 * HORA, forceRefreshDefault: true },
};

/** Converte `30s` | `45m` | `12h` | `7d` em milissegundos. */
export function parseDuracao(valor: string): number {
  const m = /^(\d+)(s|m|h|d)$/.exec(valor.trim());
  if (!m) throw new Error(`Duracao invalida: "${valor}" (use 30s, 45m, 12h, 7d)`);
  const n = Number(m[1]);
  const unidade = m[2];
  switch (unidade) {
    case 's':
      return n * SEGUNDO;
    case 'm':
      return n * MINUTO;
    case 'h':
      return n * HORA;
    default:
      return n * DIA;
  }
}

function envVarDoTipo(tipo: TipoAutomacao): string {
  return `CACHE_${tipo.toUpperCase().replace(/-/g, '_')}`;
}

export function cacheConfig(tipo: TipoAutomacao): CacheConfig {
  const base = PADRAO[tipo];
  const override = process.env[envVarDoTipo(tipo)];
  if (!override) return base;
  return { ...base, ttlMs: parseDuracao(override) };
}

/** Invalidacao global por tipo: bump de versao invalida o cache inteiro do tipo. */
export const CACHE_VERSION = 1;

/** Exposto para /metrics e testes. */
export const CACHE_PADRAO = PADRAO;

// Falha rapida em config ruim de ambiente.
if (env.NODE_ENV !== 'test') {
  for (const tipo of Object.keys(PADRAO) as TipoAutomacao[]) {
    cacheConfig(tipo);
  }
}
