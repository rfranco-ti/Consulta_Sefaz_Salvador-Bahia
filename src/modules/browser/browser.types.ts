import type { Browser, BrowserContext, Page } from 'playwright-core';

export interface BrowserSessionOptions {
  portal?: string;
  acceptDownloads?: boolean;
  storageState?: string;
}

export interface LiberarOptions {
  reciclar?: boolean;
}

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
