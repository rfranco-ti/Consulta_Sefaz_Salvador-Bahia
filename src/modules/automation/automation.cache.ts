import type { TipoAutomacao } from '../../automations/registry.js';
import { cacheConfig, CACHE_VERSION } from '../../config/cache.js';
import type { ResultadoAutomacao, CacheInfo } from './automation.types.js';

/**
 * Cache de resultados em duas camadas (.docs/ARCHITECTURE.md, JOBS.md):
 *   1. memoria (LRU) — hits em segundos/minutos
 *   2. SQLite        — duradouro, sobrevive a restart
 *
 * Regras:
 * - so SUCCESS entra no cache (erros NUNCA cacheiam);
 * - chave = sha256(tipo + params normalizados + CACHE_VERSION);
 * - forceRefresh pula leitura e regrava;
 * - TTL por tipo via src/config/cache.ts (override por ENV).
 *
 * TODO(Fase 3): implementar LRU + tabela cache_consultas.
 */
export interface ConsultaCache {
  obter(
    tipo: TipoAutomacao,
    paramsNormalizados: string,
  ): Promise<{ resultado: ResultadoAutomacao; info: CacheInfo } | null>;
  gravar(
    tipo: TipoAutomacao,
    paramsNormalizados: string,
    resultado: ResultadoAutomacao,
  ): Promise<void>;
  invalidarTipo(tipo: TipoAutomacao): Promise<void>;
}

export function chaveCache(
  tipo: TipoAutomacao,
  paramsNormalizados: string,
): string {
  // TODO(Fase 3): sha256 real; por agora, chave legivel para desenvolvimento.
  return `${tipo}:${CACHE_VERSION}:${paramsNormalizados}`;
}

export function ttlDoTipo(tipo: TipoAutomacao): number {
  return cacheConfig(tipo).ttlMs;
}
