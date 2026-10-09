import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  executarIptuSalvador,
  IptuSalvadorRobot,
  iptuSalvadorInputSchema,
} from '../../src/automations/sites/iptu-salvador/iptu-salvador.robot.js';
import type { ExecucaoCtx } from '../../src/automations/base/base-robot.js';
import type { Execucao } from '../../src/database/index.js';
import type { BrowserSession } from '../../src/modules/browser/browser.types.js';
import { obterExecutor } from '../../src/modules/jobs/executor.js';
import { obterCanalProgresso } from '../../src/modules/jobs/progresso.js';
import { EtapaError, ValidationError } from '../../src/shared/errors/index.js';

const NUMERO_MASCARA = '809741-0';
const NUMERO_DIGITOS = '8097410';

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
let formPopupHtml = '';
let popupHtml = '';
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

async function servirPopup(
  sessao: BrowserSession,
  formulario: string,
  popup: string,
): Promise<void> {
  await sessao.page.route('**/CertidaoDadosCadastraisFrm.aspx', (rota) =>
    rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: formulario }),
  );
  await sessao.context.route(
    (url) => url.href.includes('CertidaoDadosCadastraisEmissaoDtl.aspx'),
    (rota) => rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: popup }),
  );
}

async function servirSemPopup(sessao: BrowserSession, formulario: string): Promise<void> {
  await sessao.page.route('**/CertidaoDadosCadastraisFrm.aspx', (rota) =>
    rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: formulario }),
  );
  await sessao.context.route(
    (url) => url.href.includes('CertidaoResultado.aspx'),
    (rota) => rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: formulario }),
  );
}

beforeAll(async () => {
  navegador = await chromium.launch({ headless: true });
  formHtml = await lerFixture('iptu-salvador-form.html');
  formPopupHtml = await lerFixture('iptu-salvador-form-popup.html');
  popupHtml = await lerFixture('iptu-salvador-popup.html');
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
    const parsed = iptuSalvadorInputSchema.safeParse({ numeroIptu: ' 809741-0 ' });
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
    'captura o popup da certidão e extrai a certidão completa',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirPopup(sessao, formPopupHtml, popupHtml);
        const etapas: Array<string | undefined> = [];
        const deixar = obterCanalProgresso().observar('exe_fluxo_popup', (evento) => {
          etapas.push(evento.etapa);
        });
        try {
          const resultado = await executarIptuSalvador(
            montarExecucao('exe_fluxo_popup', { numeroIptu: NUMERO_MASCARA, artefatos: 'ambos' }),
            sessao,
          );
          expect(resultado['sucesso']).toBe(true);
          const dados = resultado['dados'] as Record<string, string>;
          expect(dados['numeroIptuBuscado']).toBe(NUMERO_DIGITOS);
          expect(dados['titulo']).toBe('Certidão de Dados Cadastrais Utilizados para Cálculo do IPTU 2026');
          expect(dados['inscricao']).toBe('809741-0');
          expect(dados['cib']).toBe('7VEP9F5X');
          expect(dados['inscricaoMae']).toBe('-');
          expect(dados['contribuinte']).toBe('ALEXSANDRO SANTOS BARROS');
          expect(dados['cpfCnpj']).toBe('889.763.515-68');
          expect(dados['endereco']).toBe('Avenida Engenheiro Oscar Pontes');
          expect(dados['numeroMetrico']).toBe('5');
          expect(dados['numeroPorta']).toBe('05');
          expect(dados['loteamento']).toBe('');
          expect(dados['quadra']).toBe('');
          expect(dados['lote']).toBe('');
          expect(dados['conjunto']).toBe('');
          expect(dados['edificio']).toBe('');
          expect(dados['bloco']).toBe('');
          expect(dados['subUnidadeCod']).toBe('BX');
          expect(dados['subUnidadeNome']).toBe('Box');
          expect(dados['numSubUnidade']).toBe('');
          expect(dados['bairro']).toBe('COMÉRCIO');
          expect(dados['cep']).toBe('40015-600');
          expect(dados['complemento']).toBe('');
          expect(dados['areaTerreno']).toBe('40,00');
          expect(dados['fracaoIdeal']).toBe('0,00');
          expect(dados['areaConstruida']).toBe('40,00');
          expect(dados['areaTotal']).toBe('0,00');
          expect(dados['valorVenal']).toBe('R$ 94.689,40');
          expect(dados['tipoImovel']).toBe('Comercial');
          expect(dados['padraoConstrutivo']).toBe('A1');
          expect(dados['logradouroTrib']).toBe('3277 - Avenida Engenheiro Oscar Pontes');
          expect(dados['dataLancamento']).toBe('01/01/2014');
          expect(dados['situacaoCadastral']).toBe('Ativo');
          expect(dados['situacaoFiscal']).toBe('Contribuinte');
          expect(dados['dataEmissao']).toBe('09/10/2026 15:46:32');
          expect(dados['textoCertidao']).toMatch(/Ressalvado o direito/);
          expect(dados['codigoControle']).toMatch(/E02F63C175CB21E0F6B0A1230D5ACB11/);
          expect(dados['textoValidade']).toBe('');
          expect(dados['textoRodape']).toMatch(/autenticidade/);
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
    'nomeia o PDF do popup com o padrão DADOS-CADASTRAIS-IPTU_<NUMERO>.PDF',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirPopup(sessao, formPopupHtml, popupHtml);
        const registrados: Array<{ tipo: string; caminho: string }> = [];
        const ctx: ExecucaoCtx = {
          sessao,
          emitir: () => undefined,
          registrarArquivo: (tipo, caminho, _contentType) => {
            registrados.push({ tipo: String(tipo), caminho });
          },
          artefatos: 'pdf',
          signal: AbortSignal.timeout(60000),
        };
        const robo = new IptuSalvadorRobot();
        const resultado = await robo.executar({ numeroIptu: NUMERO_MASCARA }, ctx);
        expect(resultado.sucesso).toBe(true);
        const pdfs = registrados.filter((r) => r.tipo === 'pdf_pagina');
        expect(pdfs.length).toBe(1);
        expect(path.basename(pdfs[0]?.caminho ?? '')).toBe(
          `DADOS-CADASTRAIS-IPTU_${NUMERO_DIGITOS}.PDF`,
        );
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
        await servirPopup(sessao, formPopupHtml, popupHtml);
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
        const formSemId = formPopupHtml.replace(
          'id="ctl00_ContentPlaceHolderPrincipal_txtCdInscricao" ',
          '',
        );
        await servirPopup(sessao, formSemId, popupHtml);
        const resultado = await executarIptuSalvador(
          montarExecucao('exe_fallback', { numeroIptu: NUMERO_DIGITOS }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(true);
        const dados = resultado['dados'] as Record<string, string>;
        expect(dados['inscricao']).toBe('809741-0');
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
        const formSemCampo = formPopupHtml.replace(
          '<input type="text" id="ctl00_ContentPlaceHolderPrincipal_txtCdInscricao" name="ctl00$ContentPlaceHolderPrincipal$txtCdInscricao" placeholder="Inscrição imobiliária" maxlength="10" />',
          '',
        );
        await servirPopup(sessao, formSemCampo, popupHtml);
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
    'retorna falha clara sem inventar mensagem quando o portal não abre popup',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirSemPopup(sessao, formHtml);
        const resultado = await executarIptuSalvador(
          montarExecucao('exe_sem_popup', { numeroIptu: NUMERO_DIGITOS }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(false);
        const dados = resultado['dados'] as Record<string, string>;
        expect(dados['numeroIptuBuscado']).toBe(NUMERO_DIGITOS);
        expect(String(resultado['mensagem'])).toMatch(/sem certidão/);
      } finally {
        await fechar();
      }
    },
  );

  it(
    'retorna sucesso falso com mensagem em português quando falta a inscrição no popup',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirPopup(sessao, formPopupHtml, resultadoSemInscricaoHtml);
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
