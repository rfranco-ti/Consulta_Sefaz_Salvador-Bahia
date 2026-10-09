import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  calcularExitCodeSonda,
  carregarPortalSonda,
  chavesPreInteracao,
  verificarPagina,
  type PortalSonda,
} from '../../scripts/sonda-nucleo.js';

const diretorioRaiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const diretorioFixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
);
const portalSefaz = path.join(
  diretorioRaiz,
  'src',
  'automations',
  'sites',
  'sefaz-bahia',
  'sefaz-bahia.portal.json',
);

let navegador: Browser;
let portal: PortalSonda;
let formulario = '';

async function abrirPagina(): Promise<{ pagina: Page; fechar: () => Promise<void> }> {
  const contexto = await navegador.newContext({ locale: 'pt-BR' });
  const pagina = await contexto.newPage();
  await pagina.route('**' + '/consultaBa.asp', (rota) =>
    rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: formulario }),
  );
  return {
    pagina,
    fechar: async () => {
      await pagina.close().catch(() => undefined);
      await contexto.close().catch(() => undefined);
    },
  };
}

beforeAll(async () => {
  navegador = await chromium.launch({ headless: true });
  portal = await carregarPortalSonda(portalSefaz);
  formulario = await readFile(path.join(diretorioFixtures, 'sefaz-bahia-form.html'), 'utf-8');
}, 60000);

afterAll(async () => {
  await navegador.close();
});

describe('sonda de seletores com página roteada', () => {
  it('verifica apenas campo e botão do formulário inicial', () => {
    expect(chavesPreInteracao(portal)).toEqual(['campo_cnpj', 'botao_consultar']);
  });

  it(
    'marca PASS quando o formulário contém campo e botão',
    { timeout: 60000 },
    async () => {
      const { pagina, fechar } = await abrirPagina();
      try {
        await pagina.goto(portal.navegacao.url, {
          waitUntil: portal.navegacao.waitUntil,
          timeout: portal.navegacao.timeout,
        });
        const achados = await verificarPagina(pagina, portal, chavesPreInteracao(portal));
        expect(achados).toHaveLength(2);
        expect(achados.map((achado) => achado.chave)).toEqual([
          'campo_cnpj',
          'botao_consultar',
        ]);
        for (const achado of achados) {
          expect(achado.presente).toBe(true);
        }
        expect(
          calcularExitCodeSonda(
            achados.map((achado) => ({
              robot: 'sefaz-bahia',
              seletor: achado.chave,
              situacao: achado.presente ? 'PASS' : 'FAIL',
              detalhe: achado.detalhe,
            })),
          ),
        ).toBe(0);
      } finally {
        await fechar();
      }
    },
  );

  it(
    'marca FAIL com os seletores tentados quando o campo some do portal',
    { timeout: 60000 },
    async () => {
      const semCampo = formulario.replace(
        '<input type="text" name="cnpj" maxlength="18" />',
        '',
      );
      const contexto = await navegador.newContext({ locale: 'pt-BR' });
      const pagina = await contexto.newPage();
      try {
        await pagina.route('**' + '/consultaBa.asp', (rota) =>
          rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: semCampo }),
        );
        await pagina.goto(portal.navegacao.url, {
          waitUntil: portal.navegacao.waitUntil,
          timeout: portal.navegacao.timeout,
        });
        const achados = await verificarPagina(pagina, portal, chavesPreInteracao(portal));
        const campo = achados.find((achado) => achado.chave === 'campo_cnpj');
        const botao = achados.find((achado) => achado.chave === 'botao_consultar');
        expect(campo?.presente).toBe(false);
        expect(campo?.detalhe).toContain('campo_cnpj');
        expect(botao?.presente).toBe(true);
      } finally {
        await pagina.close().catch(() => undefined);
        await contexto.close().catch(() => undefined);
      }
    },
  );
});
