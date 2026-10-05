import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  executarSefazBahiaSocio,
  sefazBahiaSocioInputSchema,
} from '../../src/automations/sites/sefaz-bahia-socio/sefaz-bahia-socio.robot.js';
import type { Execucao } from '../../src/database/index.js';
import type { BrowserSession } from '../../src/modules/browser/browser.types.js';
import { obterExecutor } from '../../src/modules/jobs/executor.js';
import { obterCanalProgresso } from '../../src/modules/jobs/progresso.js';
import { EtapaError, ValidationError } from '../../src/shared/errors/index.js';

const CPF_MASCARA = '111.444.777-35';
const CPF_DIGITOS = '11144477735';

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
let resultadoVazioHtml = '';

function montarExecucao(id: string, carga: unknown): Execucao {
  const texto = typeof carga === 'string' ? carga : JSON.stringify(carga);
  return {
    id,
    tipo: 'sefaz-bahia-socio',
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
  await sessao.page.route('**/socio.asp', (rota) =>
    rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: formulario }),
  );
  await sessao.page.route(
    (url) => url.href.includes('resultado-socio'),
    (rota) => rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: resultado }),
  );
}

beforeAll(async () => {
  navegador = await chromium.launch({ headless: true });
  formHtml = await lerFixture('sefaz-bahia-socio-form.html');
  resultadoHtml = await lerFixture('sefaz-bahia-socio-resultado.html');
  resultadoVazioHtml = await lerFixture('sefaz-bahia-socio-resultado-vazio.html');
}, 60000);

afterAll(async () => {
  await navegador.close();
});

describe('robot sefaz-bahia-socio', () => {
  it('registra seu executor no carregamento do módulo', () => {
    expect(obterExecutor('sefaz-bahia-socio')).toBe(executarSefazBahiaSocio);
  });

  it('aceita CPF com máscara e normaliza para dígitos', () => {
    const parsed = sefazBahiaSocioInputSchema.safeParse({ cpf: CPF_MASCARA });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.cpf).toBe(CPF_DIGITOS);
    }
  });

  it(
    'rejeita CPF inválido com ValidationError antes de tocar no navegador',
    { timeout: 60000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await expect(
          executarSefazBahiaSocio(montarExecucao('exe_cpf_invalido', { cpf: '123' }), sessao),
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
          executarSefazBahiaSocio(montarExecucao('exe_payload_ruim', 'não-json{'), sessao),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(sessao.page.url()).toBe('about:blank');
      } finally {
        await fechar();
      }
    },
  );

  it(
    'executa o fluxo completo offline e extrai o sócio com artefatos',
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
          const resultado = await executarSefazBahiaSocio(
            montarExecucao('exe_fluxo_feliz', { cpf: CPF_MASCARA, artefatos: 'ambos' }),
            sessao,
          );
          expect(resultado['sucesso']).toBe(true);
          const dados = resultado['dados'] as Record<string, unknown>;
          expect(dados['cpfBuscado']).toBe(CPF_DIGITOS);
          expect(dados['nome']).toBe('JOAO DA SILVA');
          expect(dados['cpf']).toBe('111.444.777-35');
          expect(dados['totalEstabelecimentos']).toBe(2);
          const estabelecimentos = dados['estabelecimentos'] as Array<Record<string, string>>;
          expect(estabelecimentos).toHaveLength(2);
          expect(estabelecimentos[0]?.['cnpj']).toBe('12.345.678/0001-95');
          expect(estabelecimentos[0]?.['inscricaoEstadual']).toBe('123456789');
          expect(estabelecimentos[0]?.['razaoSocial']).toBe('EMPRESA EXEMPLO LTDA');
          expect(estabelecimentos[0]?.['atividadeEconomica']).toContain('0623400');
          expect(estabelecimentos[0]?.['condicao']).toBe('NORMAL');
          expect(estabelecimentos[0]?.['situacao']).toBe('ATIVO');
          expect(estabelecimentos[0]?.['municipio']).toBe('SALVADOR');
          expect(estabelecimentos[0]?.['cep']).toBe('40000-000');
          expect(estabelecimentos[0]?.['dataFimVigencia']).toBe('');
          expect(estabelecimentos[1]?.['cnpj']).toBe('98.765.432/0001-10');
          expect(estabelecimentos[1]?.['razaoSocial']).toBe('OUTRA EMPRESA SA');
          expect(estabelecimentos[1]?.['cep']).toBe('40010-000');
          expect(dados['dataConsulta']).toBe('05/10/2026');
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
        const resultado = await executarSefazBahiaSocio(
          montarExecucao('exe_sem_artefatos', { cpf: CPF_DIGITOS }),
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
        const formSemName = formHtml.replace('name="CPF"', 'placeholder="CPF"');
        await servirPortal(sessao, formSemName, resultadoHtml);
        const resultado = await executarSefazBahiaSocio(
          montarExecucao('exe_fallback', { cpf: CPF_DIGITOS }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(true);
        const dados = resultado['dados'] as Record<string, unknown>;
        expect(dados['totalEstabelecimentos']).toBe(2);
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
        const formSemCampo = formHtml.replace('<p>CPF: <input type="text" name="CPF" maxlength="14" /></p>', '');
        await servirPortal(sessao, formSemCampo, resultadoHtml);
        let erro: unknown = null;
        try {
          await executarSefazBahiaSocio(montarExecucao('exe_sem_campo', { cpf: CPF_DIGITOS }), sessao);
        } catch (e) {
          erro = e;
        }
        expect(erro).toBeInstanceOf(EtapaError);
        expect((erro as EtapaError).etapa).toBe('preencher-cpf');
        expect((erro as Error).message).toContain('campo_cpf');
        expect((erro as Error).message).toContain("input[name='CPF']");
      } finally {
        await fechar();
      }
    },
  );

  it(
    'retorna sucesso falso com mensagem em português quando não há estabelecimentos',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirPortal(sessao, formHtml, resultadoVazioHtml);
        const resultado = await executarSefazBahiaSocio(
          montarExecucao('exe_vazio', { cpf: CPF_DIGITOS }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(false);
        expect(String(resultado['mensagem'])).toMatch(/Nenhum estabelecimento/);
        const dados = resultado['dados'] as Record<string, unknown>;
        expect(dados['cpfBuscado']).toBe(CPF_DIGITOS);
        expect(dados['totalEstabelecimentos']).toBe(0);
      } finally {
        await fechar();
      }
    },
  );
});
