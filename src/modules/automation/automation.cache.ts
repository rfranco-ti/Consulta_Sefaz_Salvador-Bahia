import type { TipoAutomacao } from '../../automations/registry.js';
import { cacheConfig, CACHE_VERSION } from '../../config/cache.js';
import type { ResultadoAutomacao, CacheInfo } from './automation.types.js';

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
  return `${tipo}:${CACHE_VERSION}:${paramsNormalizados}`;
}

export function ttlDoTipo(tipo: TipoAutomacao): number {
  return cacheConfig(tipo).ttlMs;
}
