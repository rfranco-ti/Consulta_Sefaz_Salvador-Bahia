import type { Locator, Page } from 'playwright-core';
import { EtapaError } from '../../shared/errors/index.js';

export const TIMEOUT_SELETOR_MS = 3000;

export interface CadeiaSeletores {
  seletores: string[];
}

export async function localizarPorChave(
  pagina: Page,
  chave: string,
  cadeias: Record<string, CadeiaSeletores>,
  etapa: string,
  timeoutPorTentativa: number = TIMEOUT_SELETOR_MS,
): Promise<Locator> {
  const candidatos = cadeias[chave]?.seletores ?? [];
  for (const candidato of candidatos) {
    const alvo = pagina.locator(candidato).first();
    const anexado = await alvo
      .waitFor({ state: 'attached', timeout: timeoutPorTentativa })
      .then(() => true, () => false);
    if (anexado) {
      return alvo;
    }
  }
  const tentados = candidatos.length > 0 ? candidatos.join(' | ') : '(cadeia vazia)';
  throw new EtapaError(etapa, `Seletor "${chave}" não encontrado. Tentados: ${tentados}`);
}
