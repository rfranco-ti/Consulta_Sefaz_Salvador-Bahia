import type { Browser, BrowserContext, Page } from 'playwright';

/**
 * Tipos do dominio de navegador (.docs/PLAYWRIGHT.md).
 */

export interface BrowserSessionOptions {
  /** Sigla do portal (carrega portal.json: recursos, captcha, perfil humano). */
  portal?: string;
  acceptDownloads?: boolean;
  /** Caminho de storageState persistido (sessao logada). */
  storageState?: string;
}

export interface LiberarOptions {
  /** Forca reciclagem do browser apos liberar (memoria/suspeita). */
  reciclar?: boolean;
}

/**
 * Sessao isolada de uma execucao: page + context prontos.
 * `liberar` fecha page+context e devolve o browser ao pool —
 * SEMPRE em finally.
 */
export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  liberar(opts?: LiberarOptions): Promise<void>;
}

export interface PoolSnapshot {
  total: number;
  ocupados: number;
  criados: number;
}
