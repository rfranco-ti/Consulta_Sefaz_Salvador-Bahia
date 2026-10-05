import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { BrowserContextService } from '../../src/modules/browser/browser.context.js';
import { BrowserFactory } from '../../src/modules/browser/browser.factory.js';
import type { PortalConfig } from '../../src/modules/browser/portal-config.js';

const silencioso = pino({ level: 'silent' });

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function metadados(): PortalConfig['metadata'] {
  return {
    nome: 'Portal de Teste',
    sigla: 'TESTE',
    versao: '1.0',
    autor: 'teste',
    dataCriacao: '2026-10-05',
    dataUltimaValidacao: '2026-10-05',
    urlOficial: 'http://127.0.0.1/',
    descricao: 'Configuração montada em memória para teste',
  };
}

function configBloqueandoImagens(): PortalConfig {
  return {
    metadata: metadados(),
    navegacao: {
      url: 'http://127.0.0.1/',
      timeout: 30000,
      waitUntil: 'load',
    },
    steps: [],
    extracao: {},
    recursos: {
      bloquearTipos: ['image', 'font', 'media'],
      bloquearHosts: [],
    },
  };
}

interface ServidorEstatico {
  servidor: Server;
  baseUrl: string;
  acessosImagem: () => number;
}

async function iniciarServidorEstatico(): Promise<ServidorEstatico> {
  let acessos = 0;
  const servidor = createServer((req, res) => {
    if (req.url === '/imagem.png') {
      acessos += 1;
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG_1PX);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      '<html><head><title>vitrine</title></head><body><img src="/imagem.png"></body></html>',
    );
  });
  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  const porta = (servidor.address() as AddressInfo).port;
  return {
    servidor,
    baseUrl: `http://127.0.0.1:${porta}/`,
    acessosImagem: () => acessos,
  };
}

async function encerrarServidor(servidor: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    servidor.close((erro) => {
      if (erro) reject(erro);
      else resolve();
    });
  });
}

describe('contexto do navegador', () => {
  it(
    'ciclo real: contexto isolado, título, stealth, screenshot, pdf e liberação',
    { timeout: 120000 },
    async () => {
      const fabrica = new BrowserFactory({ logger: silencioso });
      const sessoes = new BrowserContextService(fabrica, { logger: silencioso });
      try {
        const sessao = await sessoes.criarSessao();
        try {
          await sessao.page.setContent(
            '<html><head><title>nota fiscal</title></head><body><h1>conteúdo</h1></body></html>',
          );
          await expect(sessao.page.title()).resolves.toBe('nota fiscal');
          const webdriver = await sessao.page.evaluate(() => navigator.webdriver);
          expect(webdriver).toBeUndefined();
          const idiomas = await sessao.page.evaluate(() => navigator.languages[0]);
          expect(idiomas).toBe('pt-BR');
          const print = await sessao.page.screenshot({ type: 'jpeg', quality: 70 });
          expect(print.length).toBeGreaterThan(0);
          const pdf = await sessao.page.pdf({ format: 'A4', printBackground: true });
          expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe('%PDF-');
        } finally {
          await sessao.liberar();
        }
        expect(fabrica.snapshot().ocupados).toBe(0);
        expect(fabrica.snapshot().total).toBe(1);
      } finally {
        await fabrica.shutdown();
      }
    },
  );

  it(
    'bloqueia imagens do portal e carrega o HTML normalmente',
    { timeout: 120000 },
    async () => {
      const estatico = await iniciarServidorEstatico();
      const fabrica = new BrowserFactory({ logger: silencioso });
      const sessoes = new BrowserContextService(fabrica, { logger: silencioso });
      try {
        const sessao = await sessoes.criarSessao({
          portalConfig: configBloqueandoImagens(),
        });
        try {
          await sessao.page.goto(estatico.baseUrl, { waitUntil: 'load' });
          await sessao.page.waitForFunction(() => {
            const imagem = document.querySelector('img');
            return imagem !== null && imagem.complete === true;
          });
          await expect(sessao.page.title()).resolves.toBe('vitrine');
          expect(estatico.acessosImagem()).toBe(0);
          const largura = await sessao.page.evaluate(() => {
            const imagem = document.querySelector('img');
            return imagem === null ? -1 : imagem.naturalWidth;
          });
          expect(largura).toBe(0);
        } finally {
          await sessao.liberar();
        }
      } finally {
        await fabrica.shutdown();
        await encerrarServidor(estatico.servidor);
      }
    },
  );

  it(
    'com artefatos pdf o bloqueio de imagens e fontes é liberado',
    { timeout: 120000 },
    async () => {
      const estatico = await iniciarServidorEstatico();
      const fabrica = new BrowserFactory({ logger: silencioso });
      const sessoes = new BrowserContextService(fabrica, { logger: silencioso });
      try {
        const sessao = await sessoes.criarSessao({
          portalConfig: configBloqueandoImagens(),
          artefatos: 'pdf',
        });
        try {
          await sessao.page.goto(estatico.baseUrl, { waitUntil: 'load' });
          await sessao.page.waitForFunction(() => {
            const imagem = document.querySelector('img');
            return imagem !== null && imagem.complete === true;
          });
          expect(estatico.acessosImagem()).toBeGreaterThan(0);
          const largura = await sessao.page.evaluate(() => {
            const imagem = document.querySelector('img');
            return imagem === null ? -1 : imagem.naturalWidth;
          });
          expect(largura).toBeGreaterThan(0);
        } finally {
          await sessao.liberar();
        }
      } finally {
        await fabrica.shutdown();
        await encerrarServidor(estatico.servidor);
      }
    },
  );
});
