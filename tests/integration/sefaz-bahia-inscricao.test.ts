import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  executarSefazBahiaInscricao,
  sefazBahiaInscricaoInputSchema,
} from '../../src/automations/sites/sefaz-bahia-inscricao/sefaz-bahia-inscricao.robot.js';
import type { Execucao } from '../../src/database/index.js';
import type { BrowserSession } from '../../src/modules/browser/browser.types.js';
import { obterExecutor } from '../../src/modules/jobs/executor.js';
import { obterCanalProgresso } from '../../src/modules/jobs/progresso.js';
import { EtapaError, ValidationError } from '../../src/shared/errors/index.js';

const IE_MASCARA = '123.456.789';
const IE_DIGITOS = '123456789';

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
let resultadoHtml = '';
let resultadoSemIeHtml = '';

function montarExecucao(id: string, carga: unknown): Execucao {
  const texto = typeof carga === 'string' ? carga : JSON.stringify(carga);
  return {
    id,
    tipo: 'sefaz-bahia-inscricao',
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
  resultado: string,
): Promise<void> {
  await sessao.page.route('**/consultaBa.asp', (rota) =>
    rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: formulario }),
  );
  await sessao.page.route(
    (url) => url.href.includes('resultado.asp'),
    (rota) => rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: resultado }),
  );
}

beforeAll(async () => {
  navegador = await chromium.launch({ headless: true });
  formHtml = await lerFixture('sefaz-bahia-inscricao-form.html');
  resultadoHtml = await lerFixture('sefaz-bahia-inscricao-resultado.html');
  resultadoSemIeHtml = await lerFixture('sefaz-bahia-inscricao-resultado-sem-ie.html');
}, 60000);

afterAll(async () => {
  await navegador.close();
});

describe('robot sefaz-bahia-inscricao', () => {
  it('registra seu executor no carregamento do módulo', () => {
    expect(obterExecutor('sefaz-bahia-inscricao')).toBe(executarSefazBahiaInscricao);
  });

  it('aceita inscrição com máscara e normaliza para dígitos', () => {
    const parsed = sefazBahiaInscricaoInputSchema.safeParse({ inscricaoEstadual: IE_MASCARA });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.inscricaoEstadual).toBe(IE_DIGITOS);
    }
  });

  it(
    'rejeita inscrição inválida com ValidationError antes de tocar no navegador',
    { timeout: 60000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await expect(
          executarSefazBahiaInscricao(montarExecucao('exe_ie_invalida', { inscricaoEstadual: '123' }), sessao),
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
          executarSefazBahiaInscricao(montarExecucao('exe_payload_ruim', 'não-json{'), sessao),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(sessao.page.url()).toBe('about:blank');
      } finally {
        await fechar();
      }
    },
  );

  it(
    'executa o fluxo completo offline e extrai o cadastro com artefatos',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirPortal(sessao, formHtml, resultadoHtml);
        const etapas: Array<string | undefined> = [];
        const deixar = obterCanalProgresso().observar('exe_fluxo_feliz', (evento) => {
          etapas.push(evento.etapa);
        });
        try {
          const resultado = await executarSefazBahiaInscricao(
            montarExecucao('exe_fluxo_feliz', { inscricaoEstadual: IE_MASCARA, artefatos: 'ambos' }),
            sessao,
          );
          expect(resultado['sucesso']).toBe(true);
          const dados = resultado['dados'] as Record<string, string>;
          expect(dados['inscricaoEstadualBuscada']).toBe(IE_DIGITOS);
          expect(dados['inscricaoEstadual']).toBe('123456789');
          expect(dados['razaoSocial']).toBe('EMPRESA EXEMPLO LTDA');
          expect(dados['nomeFantasia']).toBe('LOJA EXEMPLO');
          expect(dados['cep']).toBe('40000-000');
          expect(dados['situacaoCadastral']).toBe('ATIVO');
          expect(dados['atividadeEconomica']).toContain('0623400');
          expect(dados['formaAtuacao']).toBe('ESTABELECIMENTO FIXO');
          expect(dados['complementoCorresp']).toBe('');
          expect(dados['dataConsulta']).toBe('05/10/2026');
          expect(dados['contadorNome']).toBe('FULANO DE TAL');
          expect(dados['municipioCorresp']).toBe('SALVADOR');
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
    'não gera artefatos quando artefatos é nenhum',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirPortal(sessao, formHtml, resultadoHtml);
        const resultado = await executarSefazBahiaInscricao(
          montarExecucao('exe_sem_artefatos', { inscricaoEstadual: IE_DIGITOS }),
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
    'usa o fallback de placeholder quando o name do campo some',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        const formSemName = formHtml.replace('name="inscricao"', 'placeholder="Inscrição Estadual"');
        await servirPortal(sessao, formSemName, resultadoHtml);
        const resultado = await executarSefazBahiaInscricao(
          montarExecucao('exe_fallback', { inscricaoEstadual: IE_DIGITOS }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(true);
        const dados = resultado['dados'] as Record<string, string>;
        expect(dados['inscricaoEstadual']).toBe('123456789');
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
        const formSemCampo = formHtml.replace('<input type="text" name="inscricao" maxlength="9" />', '');
        await servirPortal(sessao, formSemCampo, resultadoHtml);
        let erro: unknown = null;
        try {
          await executarSefazBahiaInscricao(montarExecucao('exe_sem_campo', { inscricaoEstadual: IE_DIGITOS }), sessao);
        } catch (e) {
          erro = e;
        }
        expect(erro).toBeInstanceOf(EtapaError);
        expect((erro as EtapaError).etapa).toBe('preencher-inscricao');
        expect((erro as Error).message).toContain('campo_inscricao_estadual');
        expect((erro as Error).message).toContain("input[name*='inscricao']");
      } finally {
        await fechar();
      }
    },
  );

  it(
    'retorna sucesso falso com mensagem em português quando falta a inscrição estadual',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirPortal(sessao, formHtml, resultadoSemIeHtml);
        const resultado = await executarSefazBahiaInscricao(
          montarExecucao('exe_sem_ie', { inscricaoEstadual: IE_DIGITOS }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(false);
        expect(String(resultado['mensagem'])).toMatch(/Inscrição Estadual/);
      } finally {
        await fechar();
      }
    },
  );
});
