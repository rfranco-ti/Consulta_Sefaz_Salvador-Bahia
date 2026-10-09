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
] as const;

export type TipoAutomacao = (typeof TIPOS_AUTOMACAO)[number];

export function ehTipoAutomacao(valor: string): valor is TipoAutomacao {
  return (TIPOS_AUTOMACAO as readonly string[]).includes(valor);
}

export const SLUG_PUBLICO: Record<string, TipoAutomacao> = {
  'sefaz-bahia-cadastro-cnpj': 'sefaz-bahia',
  'sefaz-bahia-cadastro-inscricao-estadual': 'sefaz-bahia-inscricao',
  'sefaz-bahia-socio-por-cpf': 'sefaz-bahia-socio',
  'consulta-inscricoes-cnpj': 'consulta-inscricoes',
  'iptu-dados-cadastrais': 'iptu-salvador',
  'ficha-cadastral-resumida': 'ficha-cadastral',
  'alvara-funcionamento': 'alvara-funcionamento',
  'cadin-salvador-pendencias': 'cadin-salvador',
  'dam-tff-tll': 'dam-tff-tll',
};

export function tipoPorSlug(slug: string): TipoAutomacao | null {
  return SLUG_PUBLICO[slug] ?? null;
}

export const PORTAL_DO_TIPO: Record<TipoAutomacao, string> = {
  'sefaz-bahia': 'SEFAZ_BA',
  'sefaz-bahia-inscricao': 'SEFAZ_BA',
  'sefaz-bahia-socio': 'SEFAZ_BA',
  'consulta-inscricoes': 'MULTI',
  'iptu-salvador': 'PREF_SALVADOR',
  'ficha-cadastral': 'PREF_SALVADOR',
  'alvara-funcionamento': 'PREF_SALVADOR',
  'cadin-salvador': 'PREF_SALVADOR',
  'dam-tff-tll': 'PREF_SALVADOR',
};

export interface AutomacaoRegistro {
  portal: string;
  timeoutMs: number;
}

export const registry = new Map<TipoAutomacao, AutomacaoRegistro>();
