import type { Page } from 'playwright-core';
import type { CadeiaSeletores } from './seletores.js';

export type RotulosExtracao = ReadonlyArray<readonly [string, string]>;

interface ElementoPagina {
  readonly textContent: string | null;
}

interface DocumentoPagina {
  querySelector(seletor: string): ElementoPagina | null;
}

declare const document: DocumentoPagina;

export function somenteDigitos(valor: string): string {
  return valor.replace(/\D/g, '');
}

export function semAcento(valor: string): string {
  return valor.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function formatarCep(valor: string): string {
  const digitos = somenteDigitos(valor);
  return digitos.length === 8 ? `${digitos.slice(0, 5)}-${digitos.slice(5)}` : valor;
}

export function analisarTextoComRotulos(texto: string, rotulos: RotulosExtracao): Record<string, string> {
  const campos: Record<string, string> = {};
  const mapa = new Map<string, string>(rotulos);
  for (const linha of texto.split(/\r?\n/)) {
    const corte = linha.indexOf(':');
    if (corte <= 0) {
      continue;
    }
    const rotulo = semAcento(linha.slice(0, corte).toLowerCase().replace(/\s+/g, ' ').trim());
    const chave = mapa.get(rotulo);
    if (chave === undefined || campos[chave] !== undefined) {
      continue;
    }
    campos[chave] = linha.slice(corte + 1).replace(/\s+/g, ' ').trim();
  }
  return campos;
}

export function mensagemDivergenciaCnpj(cnpjEncontrado: string, cnpjBuscado: string): string {
  return `O documento retornado refere-se ao CNPJ ${cnpjEncontrado}, não ao CNPJ ${cnpjBuscado} consultado.`;
}

export async function lerErroPortal(
  pagina: Page,
  cadeias: Record<string, CadeiaSeletores>,
  timeoutMs: number,
): Promise<string> {
  const candidatos = cadeias['mensagem_erro']?.seletores ?? [];
  const consultas = candidatos.filter((s) => !s.startsWith('xpath=') && !s.startsWith('text='));
  if (consultas.length === 0) {
    return '';
  }
  const combinado = consultas.join(', ');
  const texto = await pagina.waitForFunction(
    (seletor: string): string | null => {
      const elemento = document.querySelector(seletor);
      const conteudo = (elemento?.textContent ?? '').replace(/\s+/g, ' ').trim();
      return conteudo !== '' ? conteudo : null;
    },
    combinado,
    { timeout: timeoutMs },
  );
  return String(texto ?? '').trim();
}
