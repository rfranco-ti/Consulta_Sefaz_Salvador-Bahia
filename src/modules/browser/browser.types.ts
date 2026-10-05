import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { ArtefatosOpcao } from '../automation/automation.types.js';
import type { PortalConfig } from './portal-config.js';

export interface BrowserSessionOptions {
  portal?: string;
  portalConfig?: PortalConfig;
  artefatos?: ArtefatosOpcao;
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
