/**
 * Registro das automacoes (ver .docs/AUTOMATIONS.md).
 *
 * `TIPOS_AUTOMACAO` e contrato publico: os valores aparecem nas rotas
 * (/v1/automacoes/:tipo), no banco e na API. Mudar valor = breaking change.
 */

export const TIPOS_AUTOMACAO = [
  'sefaz-bahia',
  'sefaz-bahia-inscricao',
  'sefaz-bahia-socio',
  'consulta-inscricoes',
  'iptu-salvador',
  'ficha-cadastral',
  'alvara-funcionamento',
  'cadin-salvador',
  'dam-tff-tll',
  'dam-tll',
] as const;

export type TipoAutomacao = (typeof TIPOS_AUTOMACAO)[number];

export function ehTipoAutomacao(valor: string): valor is TipoAutomacao {
  return (TIPOS_AUTOMACAO as readonly string[]).includes(valor);
}

/** Sigla do portal de cada automacao (chave de semaforo por portal). */
export const PORTAL_DO_TIPO: Record<TipoAutomacao, string> = {
  'sefaz-bahia': 'SEFAZ_BA',
  'sefaz-bahia-inscricao': 'SEFAZ_BA',
  'sefaz-bahia-socio': 'SEFAZ_BA',
  'consulta-inscricoes': 'MULTI', // SEFAZ_BA + PREF_SALVADOR
  'iptu-salvador': 'PREF_SALVADOR',
  'ficha-cadastral': 'PREF_SALVADOR',
  'alvara-funcionamento': 'PREF_SALVADOR',
  'cadin-salvador': 'PREF_SALVADOR',
  'dam-tff-tll': 'PREF_SALVADOR',
  'dam-tll': 'PREF_SALVADOR',
};

/**
 * TODO(Fase 4): conforme os robots forem implementados, registrar aqui
 * o factory de cada um (classe Robot + inputSchema + timeoutMs).
 *
 * registry.set('sefaz-bahia', { criar: () => new SefazBahiaRobot(), ... })
 */
export interface AutomacaoRegistro {
  portal: string;
  timeoutMs: number;
}

export const registry = new Map<TipoAutomacao, AutomacaoRegistro>();
