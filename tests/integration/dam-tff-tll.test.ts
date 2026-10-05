import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  executarDamTffTll,
} from '../../src/automations/sites/dam-tff-tll/dam-tff-tll.robot.js';
import type { Execucao } from '../../src/database/index.js';
import type { BrowserSession } from '../../src/modules/browser/browser.types.js';
import { obterExecutor } from '../../src/modules/jobs/executor.js';
import { obterCanalProgresso } from '../../src/modules/jobs/progresso.js';
import { EtapaError, ValidationError } from '../../src/shared/errors/index.js';

const CGA = '1234567890123';
const EXERCICIO = '2026';
const BOLETO_BASE64 =
  'JVBERi0xLjQKMSAwIG9iajw8Lz4+ZW5kb2JqCnRyYWlsZXI8PC9Sb290IDEgMCBSPj4KJSVFT0Y=';

const diretorioFixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
);

async function lerFixture(nome: string): Promise<string> {
  return readFile(path.join(diretorioFixtures, nome), 'utf-8');
}

let navegador: Browser;
let formHtml = '';
let tunelHtml = '';
let semDividaHtml = '';
let tunelVazioHtml = '';
let tunelBoletoHtml = '';

function montarExecucao(id: string, carga: unknown): Execucao {
  const texto = typeof carga === 'string' ? carga : JSON.stringify(carga);
  return {
    id,
    tipo: 'dam-tff-tll',
    status: 'RUNNING',
    payload: texto,
    payloadBruto: texto,
    resultado: null,
    erro: null,
    attempts: 1,
    apiKeyId: 'key_teste',
    ticket: 1,
    cacheVersion: 1,
    posicaoFila: null,
    criadoEm: new Date().toISOString(),
    iniciadoEm: new Date().toISOString(),
    finalizadoEm: null,
    duracaoMs: null,
  };
}

async function abrirSessao(): Promise<{ sessao: BrowserSession; fechar: () => Promise<void> }> {
  const contexto = await navegador.newContext({ locale: 'pt-BR' });
  const pagina = await contexto.newPage();
  const sessao: BrowserSession = {
    browser: navegador,
    context: contexto,
    page: pagina,
    liberar: async () => {
      await pagina.close().catch(() => undefined);
      await contexto.close().catch(() => undefined);
    },
  };
  return { sessao, fechar: () => sessao.liberar() };
}

async function servirPortal(
  sessao: BrowserSession,
  formulario: string,
  tunel: string,
): Promise<void> {
  await sessao.page.route('**/servicos_DamTFF.asp', (rota) =>
    rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: formulario }),
  );
  await sessao.page.route(
    (url) => url.href.includes('tunel'),
    (rota) => rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: tunel }),
  );
}

beforeAll(async () => {
  navegador = await chromium.launch({ headless: true });
  formHtml = await lerFixture('dam-tff-tll-form.html');
  tunelHtml = await lerFixture('dam-tff-tll-tunel.html');
  semDividaHtml = await lerFixture('dam-tff-tll-sem-divida.html');
  tunelVazioHtml = await lerFixture('dam-tff-tll-tunel-vazio.html');
  tunelBoletoHtml = await lerFixture('dam-tff-tll-tunel-boleto.html');
}, 60000);

afterAll(async () => {
  await navegador.close();
});

describe('robot dam-tff-tll', () => {
  it('registra seu executor no carregamento do módulo', () => {
    expect(obterExecutor('dam-tff-tll')).toBe(executarDamTffTll);
  });

  it(
    'rejeita CGA inválida com ValidationError antes de tocar no navegador',
    { timeout: 60000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await expect(
          executarDamTffTll(
            montarExecucao('exe_cga_invalida', { cga: 'abc', exercicio: EXERCICIO }),
            sessao,
          ),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(sessao.page.url()).toBe('about:blank');
      } finally {
        await fechar();
      }
    },
  );

  it(
    'rejeita exercício inválido com ValidationError antes de tocar no navegador',
    { timeout: 60000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await expect(
          executarDamTffTll(
            montarExecucao('exe_exercicio_invalido', { cga: CGA, exercicio: '26' }),
            sessao,
          ),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(sessao.page.url()).toBe('about:blank');
      } finally {
        await fechar();
      }
    },
  );

  it(
    'rejeita payload fora do JSON com ValidationError',
    { timeout: 60000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await expect(
          executarDamTffTll(montarExecucao('exe_payload_ruim', 'não-json{'), sessao),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(sessao.page.url()).toBe('about:blank');
      } finally {
        await fechar();
      }
    },
  );

  it(
    'executa o fluxo completo offline e extrai o túnel com artefatos',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirPortal(sessao, formHtml, tunelHtml);
        const etapas: Array<string | undefined> = [];
        const deixar = obterCanalProgresso().observar('exe_fluxo_feliz', (evento) => {
          etapas.push(evento.etapa);
        });
        try {
          const resultado = await executarDamTffTll(
            montarExecucao('exe_fluxo_feliz', {
              inscricaoMunicipal: CGA,
              exercicio: EXERCICIO,
              artefatos: 'ambos',
            }),
            sessao,
          );
          expect(resultado['sucesso']).toBe(true);
          const dados = resultado['dados'] as Record<string, unknown>;
          expect(dados['inscricaoMunicipal']).toBe(CGA);
          expect(dados['exercicio']).toBe(EXERCICIO);
          expect(dados['contribuinte']).toBe('EMPRESA EXEMPLO LTDA');
          expect(dados['cnpj']).toBe('12.345.678/0001-95');
          expect(dados['situacao']).toBe('EM_ABERTO');
          expect(dados['totalCotas']).toBe(2);
          expect(dados['cotasEmAberto']).toBe(1);
          expect(dados['valorTotalAberto']).toBe(1345.67);
          expect(dados['proximoVencimento']).toBe('31/01/2026');
          const cotas = dados['cotas'] as Array<Record<string, unknown>>;
          expect(cotas[0]).toMatchObject({
            cota: 'Única',
            numeroCota: null,
            situacao: 'Em aberto',
            tributo: 'TFF-TLL',
            valorOriginal: 1234.56,
            valorCorrigido: 1345.67,
            vencimento: '31/01/2026',
          });
          expect(cotas[1]).toMatchObject({ cota: '1', numeroCota: 1, situacao: 'Quitada' });
          expect(resultado['mensagem']).toMatch(/sucesso/);
          expect(typeof resultado['printBase64']).toBe('string');
          expect((resultado['printBase64'] as string).startsWith('/9j')).toBe(true);
          expect(typeof resultado['pdfBase64']).toBe('string');
          expect((resultado['pdfBase64'] as string).startsWith('JVBERi')).toBe(true);
          expect(etapas.length).toBeGreaterThan(3);
          expect(etapas.some((etapa) => etapa?.includes('Extraindo'))).toBe(true);
        } finally {
          deixar();
        }
      } finally {
        await fechar();
      }
    },
  );

  it(
    'aceita cga como alias da inscrição municipal',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirPortal(sessao, formHtml, tunelHtml);
        const resultado = await executarDamTffTll(
          montarExecucao('exe_alias_cga', { cga: CGA, exercicio: 2026 }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(true);
        const dados = resultado['dados'] as Record<string, unknown>;
        expect(dados['inscricaoMunicipal']).toBe(CGA);
      } finally {
        await fechar();
      }
    },
  );

  it(
    'não gera artefatos quando artefatos é nenhum',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirPortal(sessao, formHtml, tunelHtml);
        const resultado = await executarDamTffTll(
          montarExecucao('exe_sem_artefatos', { cga: CGA, exercicio: EXERCICIO }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(true);
        expect(resultado['printBase64']).toBeUndefined();
        expect(resultado['pdfBase64']).toBeUndefined();
      } finally {
        await fechar();
      }
    },
  );

  it(
    'captura o PDF do boleto quando o portal serve o embed pdfID',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirPortal(sessao, formHtml, tunelBoletoHtml);
        const resultado = await executarDamTffTll(
          montarExecucao('exe_boleto', { cga: CGA, exercicio: EXERCICIO, artefatos: 'pdf' }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(true);
        expect(resultado['pdfBase64']).toBe(BOLETO_BASE64);
        expect(resultado['printBase64']).toBeUndefined();
      } finally {
        await fechar();
      }
    },
  );

  it(
    'usa o fallback de placeholder quando o name do campo some',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        const formSemName = formHtml.replace('name="cdCGA"', 'placeholder="CGA"');
        await servirPortal(sessao, formSemName, tunelHtml);
        const resultado = await executarDamTffTll(
          montarExecucao('exe_fallback', { cga: CGA, exercicio: EXERCICIO }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(true);
        const dados = resultado['dados'] as Record<string, unknown>;
        expect(dados['contribuinte']).toBe('EMPRESA EXEMPLO LTDA');
      } finally {
        await fechar();
      }
    },
  );

  it(
    'falha rica com chave lógica e etapa quando o campo some do portal',
    { timeout: 60000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        const formSemCampo = formHtml.replace(
          '<p>Inscrição Municipal (CGA): <input type="text" name="cdCGA" maxlength="15" /></p>',
          '',
        );
        await servirPortal(sessao, formSemCampo, tunelHtml);
        let erro: unknown = null;
        try {
          await executarDamTffTll(montarExecucao('exe_sem_campo', { cga: CGA, exercicio: EXERCICIO }), sessao);
        } catch (e) {
          erro = e;
        }
        expect(erro).toBeInstanceOf(EtapaError);
        expect((erro as EtapaError).etapa).toBe('preencher-cga');
        expect((erro as Error).message).toContain('campo_cga');
        expect((erro as Error).message).toContain("input[name='cdCGA']");
      } finally {
        await fechar();
      }
    },
  );

  it(
    'retorna sucesso com SEM_COTAS quando o portal avisa sem dívida',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirPortal(sessao, formHtml, semDividaHtml);
        const resultado = await executarDamTffTll(
          montarExecucao('exe_sem_divida', { cga: CGA, exercicio: EXERCICIO }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(true);
        const dados = resultado['dados'] as Record<string, unknown>;
        expect(dados['situacao']).toBe('SEM_COTAS');
        expect(String(resultado['mensagem'])).toMatch(/dívida/);
      } finally {
        await fechar();
      }
    },
  );

  it(
    'retorna sucesso falso com mensagem em português quando o túnel vem vazio',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirPortal(sessao, formHtml, tunelVazioHtml);
        const resultado = await executarDamTffTll(
          montarExecucao('exe_tunel_vazio', { cga: CGA, exercicio: EXERCICIO }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(false);
        expect(String(resultado['mensagem'])).toMatch(/Nenhuma cota/);
      } finally {
        await fechar();
      }
    },
  );
});
