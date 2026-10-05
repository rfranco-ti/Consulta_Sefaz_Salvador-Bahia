import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import {
  BrowserFactory,
  montarUA,
  UA_FALLBACK,
} from '../../src/modules/browser/browser.factory.js';
import { BrowserError } from '../../src/shared/errors/index.js';

const silencioso = pino({ level: 'silent' });

async function esperarPor(condicao: () => boolean, limiteMs = 15000): Promise<void> {
  const inicio = Date.now();
  while (!condicao()) {
    if (Date.now() - inicio > limiteMs) throw new Error('Tempo esgotado aguardando condição');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('montarUA', () => {
  it('monta UA de Windows a partir da versão do engine', () => {
    const ua = montarUA('153.0.8010.12', 'win32');
    expect(ua).toContain('Windows NT 10.0; Win64; x64');
    expect(ua).toContain('Chrome/153.0.8010.12');
    expect(ua).not.toContain('HeadlessChrome');
  });

  it('monta UA de Linux a partir da versão do engine', () => {
    const ua = montarUA('153.0.8010.12', 'linux');
    expect(ua).toContain('X11; Linux x86_64');
    expect(ua).toContain('Chrome/153.0.8010.12');
  });

  it('versão fora do padrão cai no fallback', () => {
    expect(montarUA('invalida', 'linux')).toBe(UA_FALLBACK);
    expect(montarUA('153.0.8010.12', 'sunos')).toBe(UA_FALLBACK);
  });
});

describe('pool de navegadores', () => {
  it(
    'acquire entrega browser conectado, conta ocupação e devolve no release',
    { timeout: 90000 },
    async () => {
      const fabrica = new BrowserFactory({ logger: silencioso });
      try {
        expect(fabrica.snapshot()).toEqual({ total: 0, ocupados: 0, criados: 0 });
        const browser = await fabrica.acquire();
        expect(browser.isConnected()).toBe(true);
        expect(fabrica.snapshot()).toEqual({ total: 1, ocupados: 1, criados: 1 });
        await fabrica.release(browser);
        expect(fabrica.snapshot()).toEqual({ total: 1, ocupados: 0, criados: 1 });
      } finally {
        await fabrica.shutdown();
      }
      expect(fabrica.snapshot().total).toBe(0);
    },
  );

  it(
    'getRealUA nunca expõe a marca HeadlessChrome',
    { timeout: 90000 },
    async () => {
      const fabrica = new BrowserFactory({ logger: silencioso });
      try {
        const ua = await fabrica.getRealUA();
        expect(ua).toContain('Chrome/');
        expect(ua).not.toContain('HeadlessChrome');
        const browser = await fabrica.acquire();
        expect(browser.isConnected()).toBe(true);
        const uaQuente = await fabrica.getRealUA();
        expect(uaQuente).toContain('Chrome/');
        expect(uaQuente).not.toContain('HeadlessChrome');
        await fabrica.release(browser);
      } finally {
        await fabrica.shutdown();
      }
    },
  );

  it(
    'recicla em background sem derrubar quem está em uso',
    { timeout: 120000 },
    async () => {
      const fabrica = new BrowserFactory({
        maxUsosAntesReciclar: 2,
        logger: silencioso,
      });
      try {
        const primeiro = await fabrica.acquire();
        await fabrica.release(primeiro);
        const segundo = await fabrica.acquire();
        expect(segundo).toBe(primeiro);
        await esperarPor(() => fabrica.snapshot().criados >= 2);
        expect(fabrica.snapshot().total).toBe(2);
        await fabrica.release(segundo);
        await esperarPor(() => fabrica.snapshot().total === 1);
        const terceiro = await fabrica.acquire();
        expect(terceiro.isConnected()).toBe(true);
        expect(terceiro).not.toBe(segundo);
        await fabrica.release(terceiro);
      } finally {
        await fabrica.shutdown();
      }
    },
  );

  it(
    'desliga por ociosidade e relança no próximo acquire',
    { timeout: 90000 },
    async () => {
      const fabrica = new BrowserFactory({ idleTtlMs: 300, logger: silencioso });
      try {
        const browser = await fabrica.acquire();
        await fabrica.release(browser);
        expect(fabrica.snapshot().total).toBe(1);
        await esperarPor(() => fabrica.snapshot().total === 0);
        const relancado = await fabrica.acquire();
        expect(relancado.isConnected()).toBe(true);
        expect(fabrica.snapshot().criados).toBe(2);
        await fabrica.release(relancado);
      } finally {
        await fabrica.shutdown();
      }
    },
  );

  it(
    'shutdown é gracioso e acquire posterior falha com erro tipado',
    { timeout: 90000 },
    async () => {
      const fabrica = new BrowserFactory({ logger: silencioso });
      const browser = await fabrica.acquire();
      await fabrica.release(browser);
      await fabrica.shutdown();
      expect(fabrica.snapshot()).toEqual({ total: 0, ocupados: 0, criados: 1 });
      await expect(fabrica.acquire()).rejects.toBeInstanceOf(BrowserError);
    },
  );
});
