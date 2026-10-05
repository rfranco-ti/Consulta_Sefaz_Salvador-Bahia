import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  executarIptuSalvador,
  iptuSalvadorInputSchema,
} from '../../src/automations/sites/iptu-salvador/iptu-salvador.robot.js';
import type { Execucao } from '../../src/database/index.js';
import type { BrowserSession } from '../../src/modules/browser/browser.types.js';
import { obterExecutor } from '../../src/modules/jobs/executor.js';
import { obterCanalProgresso } from '../../src/modules/jobs/progresso.js';
import { EtapaError, ValidationError } from '../../src/shared/errors/index.js';

const NUMERO_MASCARA = ' 00123-456 ';
const NUMERO_DIGITOS = '00123456';

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
let resultadoSemInscricaoHtml = '';

function montarExecucao(id: string, carga: unknown): Execucao {
  const texto = typeof carga === 'string' ? carga : JSON.stringify(carga);
  return {
    id,
    tipo: 'iptu-salvador',
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
  await sessao.page.route('**/CertidaoDadosCadastraisFrm.aspx', (rota) =>
    rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: formulario }),
  );
  await sessao.page.route(
    (url) => url.href.includes('CertidaoResultado.aspx'),
    (rota) => rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: resultado }),
  );
}

beforeAll(async () => {
  navegador = await chromium.launch({ headless: true });
  formHtml = await lerFixture('iptu-salvador-form.html');
  resultadoHtml = await lerFixture('iptu-salvador-resultado.html');
  resultadoSemInscricaoHtml = await lerFixture('iptu-salvador-resultado-sem-inscricao.html');
}, 60000);

afterAll(async () => {
  await navegador.close();
});

describe('robot iptu-salvador', () => {
  it('registra seu executor no carregamento do módulo', () => {
    expect(obterExecutor('iptu-salvador')).toBe(executarIptuSalvador);
  });

  it('aceita número com máscara e normaliza para dígitos', () => {
    const parsed = iptuSalvadorInputSchema.safeParse({ numeroIptu: NUMERO_MASCARA });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.numeroIptu).toBe(NUMERO_DIGITOS);
    }
  });

  it(
    'rejeita número inválido com ValidationError antes de tocar no navegador',
    { timeout: 60000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await expect(
          executarIptuSalvador(montarExecucao('exe_iptu_invalido', { numeroIptu: '123' }), sessao),
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
          executarIptuSalvador(montarExecucao('exe_payload_ruim', 'não-json{'), sessao),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(sessao.page.url()).toBe('about:blank');
      } finally {
        await fechar();
      }
    },
  );

  it(
    'executa o fluxo completo offline e extrai a certidão com artefatos',
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
          const resultado = await executarIptuSalvador(
            montarExecucao('exe_fluxo_feliz', { numeroIptu: NUMERO_MASCARA, artefatos: 'ambos' }),
            sessao,
          );
          expect(resultado['sucesso']).toBe(true);
          const dados = resultado['dados'] as Record<string, string>;
          expect(dados['numeroIptuBuscado']).toBe(NUMERO_DIGITOS);
          expect(dados['inscricao']).toBe('00123456');
          expect(dados['titulo']).toBe('CERTIDÃO DE DADOS CADASTRAIS');
          expect(dados['contribuinte']).toBe('JOSE DA SILVA');
          expect(dados['cpfCnpj']).toBe('123.456.789-01');
          expect(dados['endereco']).toBe('RUA DAS FLORES');
          expect(dados['bairro']).toBe('CENTRO');
          expect(dados['cep']).toBe('40000-000');
          expect(dados['valorVenal']).toBe('150000,00');
          expect(dados['situacaoCadastral']).toBe('ATIVA');
          expect(dados['situacaoFiscal']).toBe('REGULAR');
          expect(dados['codigoControle']).toBe('ABC123XYZ');
          expect(dados['dataEmissao']).toBe('05/10/2026');
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
        const resultado = await executarIptuSalvador(
          montarExecucao('exe_sem_artefatos', { numeroIptu: NUMERO_DIGITOS }),
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
    'usa o fallback de placeholder quando o id do campo some',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        const formSemId = formHtml.replace(
          'id="ctl00_ContentPlaceHolderPrincipal_txtCdInscricao" ',
          '',
        );
        await servirPortal(sessao, formSemId, resultadoHtml);
        const resultado = await executarIptuSalvador(
          montarExecucao('exe_fallback', { numeroIptu: NUMERO_DIGITOS }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(true);
        const dados = resultado['dados'] as Record<string, string>;
        expect(dados['inscricao']).toBe('00123456');
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
          '<input type="text" id="ctl00_ContentPlaceHolderPrincipal_txtCdInscricao" name="ctl00$ContentPlaceHolderPrincipal$txtCdInscricao" placeholder="Inscrição imobiliária" maxlength="10" />',
          '',
        );
        await servirPortal(sessao, formSemCampo, resultadoHtml);
        let erro: unknown = null;
        try {
          await executarIptuSalvador(montarExecucao('exe_sem_campo', { numeroIptu: NUMERO_DIGITOS }), sessao);
        } catch (e) {
          erro = e;
        }
        expect(erro).toBeInstanceOf(EtapaError);
        expect((erro as EtapaError).etapa).toBe('preencher-inscricao');
        expect((erro as Error).message).toContain('campo_inscricao');
        expect((erro as Error).message).toContain('#ctl00_ContentPlaceHolderPrincipal_txtCdInscricao');
      } finally {
        await fechar();
      }
    },
  );

  it(
    'retorna sucesso falso com mensagem em português quando falta a inscrição',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirPortal(sessao, formHtml, resultadoSemInscricaoHtml);
        const resultado = await executarIptuSalvador(
          montarExecucao('exe_sem_inscricao', { numeroIptu: NUMERO_DIGITOS }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(false);
        expect(String(resultado['mensagem'])).toMatch(/Inscrição imobiliária/);
      } finally {
        await fechar();
      }
    },
  );
});
