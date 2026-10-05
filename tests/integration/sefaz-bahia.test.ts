import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  executarSefazBahia,
  sefazBahiaInputSchema,
} from '../../src/automations/sites/sefaz-bahia/sefaz-bahia.robot.js';
import type { Execucao } from '../../src/database/index.js';
import type { BrowserSession } from '../../src/modules/browser/browser.types.js';
import { obterExecutor } from '../../src/modules/jobs/executor.js';
import { obterCanalProgresso } from '../../src/modules/jobs/progresso.js';
import { EtapaError, ValidationError } from '../../src/shared/errors/index.js';

const CNPJ_MASCARA = '12.345.678/0001-95';
const CNPJ_DIGITOS = '12345678000195';

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
    tipo: 'sefaz-bahia',
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
  formHtml = await lerFixture('sefaz-bahia-form.html');
  resultadoHtml = await lerFixture('sefaz-bahia-resultado.html');
  resultadoSemIeHtml = await lerFixture('sefaz-bahia-resultado-sem-ie.html');
}, 60000);

afterAll(async () => {
  await navegador.close();
});

describe('robot sefaz-bahia', () => {
  it('registra seu executor no carregamento do módulo', () => {
    expect(obterExecutor('sefaz-bahia')).toBe(executarSefazBahia);
  });

  it('aceita CNPJ com máscara e normaliza para dígitos', () => {
    const parsed = sefazBahiaInputSchema.safeParse({ cnpj: CNPJ_MASCARA });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.cnpj).toBe(CNPJ_DIGITOS);
    }
  });

  it(
    'rejeita CNPJ inválido com ValidationError antes de tocar no navegador',
    { timeout: 60000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await expect(
          executarSefazBahia(montarExecucao('exe_cnpj_invalido', { cnpj: '123' }), sessao),
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
          executarSefazBahia(montarExecucao('exe_payload_ruim', 'não-json{'), sessao),
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
          const resultado = await executarSefazBahia(
            montarExecucao('exe_fluxo_feliz', { cnpj: CNPJ_MASCARA, artefatos: 'ambos' }),
            sessao,
          );
          expect(resultado['sucesso']).toBe(true);
          const dados = resultado['dados'] as Record<string, string>;
          expect(dados['cnpjBuscado']).toBe(CNPJ_DIGITOS);
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
        const resultado = await executarSefazBahia(
          montarExecucao('exe_sem_artefatos', { cnpj: CNPJ_DIGITOS }),
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
        const formSemName = formHtml.replace('name="cnpj"', 'placeholder="CNPJ"');
        await servirPortal(sessao, formSemName, resultadoHtml);
        const resultado = await executarSefazBahia(
          montarExecucao('exe_fallback', { cnpj: CNPJ_DIGITOS }),
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
        const formSemCampo = formHtml.replace('<input type="text" name="cnpj" maxlength="18" />', '');
        await servirPortal(sessao, formSemCampo, resultadoHtml);
        let erro: unknown = null;
        try {
          await executarSefazBahia(montarExecucao('exe_sem_campo', { cnpj: CNPJ_DIGITOS }), sessao);
        } catch (e) {
          erro = e;
        }
        expect(erro).toBeInstanceOf(EtapaError);
        expect((erro as EtapaError).etapa).toBe('preencher-cnpj');
        expect((erro as Error).message).toContain('campo_cnpj');
        expect((erro as Error).message).toContain("input[name*='cnpj']");
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
        const resultado = await executarSefazBahia(
          montarExecucao('exe_sem_ie', { cnpj: CNPJ_DIGITOS }),
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
