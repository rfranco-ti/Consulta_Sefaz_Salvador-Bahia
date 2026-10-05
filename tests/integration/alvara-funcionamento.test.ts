import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  registrarExtratorTextoPdf,
  removerExtratorTextoPdf,
} from '../../src/automations/base/ocr.js';
import {
  alvaraFuncionamentoInputSchema,
  analisarTextoAlvara,
  executarAlvaraFuncionamento,
} from '../../src/automations/sites/alvara-funcionamento/alvara-funcionamento.robot.js';
import type { Execucao } from '../../src/database/index.js';
import type { BrowserSession } from '../../src/modules/browser/browser.types.js';
import { obterExecutor } from '../../src/modules/jobs/executor.js';
import { obterCanalProgresso } from '../../src/modules/jobs/progresso.js';
import { EtapaError, ValidationError } from '../../src/shared/errors/index.js';

const CNPJ_MASCARA = '12.345.678/0001-95';
const CNPJ_DIGITOS = '12345678000195';
const CGA_MASCARA = '00.256.763/001-37';
const CGA_DIGITOS = '0025676300137';

const TEXTO_ALVARA = [
  'RAZÃO SOCIAL: EMPRESA EXEMPLO LTDA',
  'NOME FANTASIA: LOJA EXEMPLO',
  'CNPJ: 12.345.678/0001-95',
  'CGA: 0025676300137',
  'NATUREZA JURÍDICA: SOCIEDADE EMPRESÁRIA LIMITADA',
  'FORMA DE ATUAÇÃO: ESTABELECIMENTO FIXO',
  'SITUAÇÃO CADASTRAL: Ativa Regular',
  'DATA DE INSCRIÇÃO: 10/01/2020',
  'VALIDADE DO ALVARÁ: 31/12/2026',
  'CÓDIGO DE CONTROLE: CTRL123XYZ',
  'LOGRADOURO: RUA DAS FLORES',
  'BAIRRO: CENTRO',
  'CNAE PRINCIPAL: 4712-1/00',
].join('\n');

const CNPJ_DIVERGENTE_DIGITOS = '11222333000181';

const TEXTO_ALVARA_CNPJ_DIVERGENTE = TEXTO_ALVARA.replace('12.345.678/0001-95', '11.222.333/0001-81');

const TEXTO_ALVARA_SEM_CNPJ = [
  'NOME FANTASIA: LOJA EXEMPLO',
  'CGA: 0025676300137',
  'NATUREZA JURÍDICA: SOCIEDADE EMPRESÁRIA LIMITADA',
  'SITUAÇÃO CADASTRAL: Ativa Regular',
  'VALIDADE DO ALVARÁ: 31/12/2026',
].join('\n');

const PDF_FIXTURE = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj',
  'trailer<</Root 1 0 R>>',
  '%%EOF',
  '% preenchimento para corpo realista do documento oficial',
].join('\n');

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
let erroHtml = '';
let ultimoPdfLido = '';

function montarExecucao(id: string, carga: unknown): Execucao {
  const texto = typeof carga === 'string' ? carga : JSON.stringify(carga);
  return {
    id,
    tipo: 'alvara-funcionamento',
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
  const contexto = await navegador.newContext({ locale: 'pt-BR', acceptDownloads: true });
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
  modo: 'pdf' | 'erro',
): Promise<void> {
  await sessao.page.route(
    (url) => url.href.includes('AlvaraCgaEmissaoFrm.aspx'),
    (rota) => rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: formulario }),
  );
  await sessao.page.route(
    (url) => url.href.includes('AlvaraDownload.pdf'),
    (rota) => {
      if (modo === 'pdf') {
        return rota.fulfill({
          status: 200,
          contentType: 'application/pdf',
          headers: { 'content-disposition': 'attachment; filename="alvara.pdf"' },
          body: PDF_FIXTURE,
        });
      }
      return rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: erroHtml });
    },
  );
}

beforeAll(async () => {
  navegador = await chromium.launch({ headless: true });
  formHtml = await lerFixture('alvara-funcionamento-form.html');
  erroHtml = await lerFixture('alvara-funcionamento-erro.html');
  ultimoPdfLido = '';
  registrarExtratorTextoPdf(async (caminho) => {
    ultimoPdfLido = caminho;
    return TEXTO_ALVARA;
  });
}, 60000);

afterAll(async () => {
  removerExtratorTextoPdf();
  await navegador.close();
});

describe('robot alvara-funcionamento', () => {
  it('registra seu executor no carregamento do módulo', () => {
    expect(obterExecutor('alvara-funcionamento')).toBe(executarAlvaraFuncionamento);
  });

  it('aceita CNPJ e CGA com máscara e normaliza para dígitos', () => {
    const parsed = alvaraFuncionamentoInputSchema.safeParse({
      cnpj: CNPJ_MASCARA,
      inscricaoMunicipal: CGA_MASCARA,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.cnpj).toBe(CNPJ_DIGITOS);
      expect(parsed.data.inscricaoMunicipal).toBe(CGA_DIGITOS);
    }
  });

  it('converte linhas ROTULO: valor do texto do alvará em campos', () => {
    const campos = analisarTextoAlvara(TEXTO_ALVARA);
    expect(campos['razaoSocial']).toBe('EMPRESA EXEMPLO LTDA');
    expect(campos['cnpj']).toBe('12.345.678/0001-95');
    expect(campos['situacaoCadastral']).toBe('Ativa Regular');
    expect(campos['codigoControle']).toBe('CTRL123XYZ');
    expect(campos['cnaeCodigo']).toBe('4712-1/00');
  });

  it(
    'rejeita CNPJ inválido com ValidationError antes de tocar no navegador',
    { timeout: 60000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await expect(
          executarAlvaraFuncionamento(
            montarExecucao('exe_cnpj_invalido', { cnpj: '123', inscricaoMunicipal: CGA_DIGITOS }),
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
    'rejeita CGA inválida com ValidationError antes de tocar no navegador',
    { timeout: 60000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await expect(
          executarAlvaraFuncionamento(
            montarExecucao('exe_cga_invalida', { cnpj: CNPJ_DIGITOS, cga: '12' }),
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
          executarAlvaraFuncionamento(montarExecucao('exe_payload_ruim', 'não-json{'), sessao),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(sessao.page.url()).toBe('about:blank');
      } finally {
        await fechar();
      }
    },
  );

  it(
    'executa o fluxo completo offline, baixa o PDF oficial e extrai o alvará com artefatos',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirPortal(sessao, formHtml, 'pdf');
        const etapas: Array<string | undefined> = [];
        const deixar = obterCanalProgresso().observar('exe_fluxo_feliz', (evento) => {
          etapas.push(evento.etapa);
        });
        try {
          const resultado = await executarAlvaraFuncionamento(
            montarExecucao('exe_fluxo_feliz', {
              cnpj: CNPJ_MASCARA,
              inscricaoMunicipal: CGA_MASCARA,
              artefatos: 'ambos',
            }),
            sessao,
          );
          expect(resultado['sucesso']).toBe(true);
          const dados = resultado['dados'] as Record<string, string>;
          expect(dados['cnpjBuscado']).toBe(CNPJ_DIGITOS);
          expect(dados['inscricaoMunicipalBuscada']).toBe(CGA_DIGITOS);
          expect(dados['razaoSocial']).toBe('EMPRESA EXEMPLO LTDA');
          expect(dados['nomeFantasia']).toBe('LOJA EXEMPLO');
          expect(dados['situacaoCadastral']).toBe('Ativa Regular');
          expect(dados['validadeAlvara']).toBe('31/12/2026');
          expect(dados['codigoControle']).toBe('CTRL123XYZ');
          expect(dados['logradouro']).toBe('RUA DAS FLORES');
          expect(dados['bairro']).toBe('CENTRO');
          expect(dados['cnaeCodigo']).toBe('4712-1/00');
          expect(resultado['mensagem']).toMatch(/sucesso/);
          expect(ultimoPdfLido.endsWith('alvara.pdf')).toBe(true);
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
        await servirPortal(sessao, formHtml, 'pdf');
        const resultado = await executarAlvaraFuncionamento(
          montarExecucao('exe_sem_artefatos', { cnpj: CNPJ_DIGITOS, inscricaoMunicipal: CGA_DIGITOS }),
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
    'usa o fallback por name quando o id do campo some',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        const formSemId = formHtml.replace(
          'id="ctl00_ContentPlaceHolderPrincipal_txtNuCnpj" ',
          '',
        );
        await servirPortal(sessao, formSemId, 'pdf');
        const resultado = await executarAlvaraFuncionamento(
          montarExecucao('exe_fallback', { cnpj: CNPJ_DIGITOS, inscricaoMunicipal: CGA_DIGITOS }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(true);
        const dados = resultado['dados'] as Record<string, string>;
        expect(dados['razaoSocial']).toBe('EMPRESA EXEMPLO LTDA');
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
          '<p>CNPJ: <input type="text" id="ctl00_ContentPlaceHolderPrincipal_txtNuCnpj" name="ctl00$ContentPlaceHolderPrincipal$txtNuCnpj" placeholder="CNPJ" maxlength="18" /></p>',
          '',
        );
        await servirPortal(sessao, formSemCampo, 'pdf');
        let erro: unknown = null;
        try {
          await executarAlvaraFuncionamento(
            montarExecucao('exe_sem_campo', { cnpj: CNPJ_DIGITOS, inscricaoMunicipal: CGA_DIGITOS }),
            sessao,
          );
        } catch (e) {
          erro = e;
        }
        expect(erro).toBeInstanceOf(EtapaError);
        expect((erro as EtapaError).etapa).toBe('preencher-cnpj');
        expect((erro as Error).message).toContain('campo_cnpj');
        expect((erro as Error).message).toContain('#ctl00_ContentPlaceHolderPrincipal_txtNuCnpj');
      } finally {
        await fechar();
      }
    },
  );

  it(
    'retorna sucesso falso com mensagem em português quando o portal rejeita a consulta',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirPortal(sessao, formHtml, 'erro');
        const resultado = await executarAlvaraFuncionamento(
          montarExecucao('exe_erro_portal', { cnpj: CNPJ_DIGITOS, inscricaoMunicipal: CGA_DIGITOS }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(false);
        expect(String(resultado['mensagem'])).toMatch(/Alvará não encontrado/);
      } finally {
        await fechar();
      }
    },
  );

  it('retorna sucesso falso quando o CNPJ do documento diverge do buscado', { timeout: 90000 }, async () => {
    const { sessao, fechar } = await abrirSessao();
    registrarExtratorTextoPdf(async () => TEXTO_ALVARA_CNPJ_DIVERGENTE);
    try {
      await servirPortal(sessao, formHtml, 'pdf');
      const resultado = await executarAlvaraFuncionamento(
        montarExecucao('exe_cnpj_divergente', { cnpj: CNPJ_DIGITOS, inscricaoMunicipal: CGA_DIGITOS }),
        sessao,
      );
      expect(resultado['sucesso']).toBe(false);
      expect(String(resultado['mensagem'])).toContain(CNPJ_DIVERGENTE_DIGITOS);
      expect(String(resultado['mensagem'])).toContain(CNPJ_DIGITOS);
      const dados = resultado['dados'] as Record<string, string>;
      expect(dados['cnpjBuscado']).toBe(CNPJ_DIGITOS);
      expect(dados['cnpjEncontrado']).toBe(CNPJ_DIVERGENTE_DIGITOS);
    } finally {
      registrarExtratorTextoPdf(async () => TEXTO_ALVARA);
      await fechar();
    }
  });

  it('mantém o gate por razão social quando o CNPJ extraído está vazio', { timeout: 90000 }, async () => {
    const { sessao, fechar } = await abrirSessao();
    registrarExtratorTextoPdf(async () => TEXTO_ALVARA_SEM_CNPJ);
    try {
      await servirPortal(sessao, formHtml, 'pdf');
      const resultado = await executarAlvaraFuncionamento(
        montarExecucao('exe_cnpj_vazio', { cnpj: CNPJ_DIGITOS, inscricaoMunicipal: CGA_DIGITOS }),
        sessao,
      );
      expect(resultado['sucesso']).toBe(false);
      expect(String(resultado['mensagem'])).toMatch(/Alvará não encontrado/);
      expect(String(resultado['mensagem'])).not.toContain('refere-se');
      const dados = resultado['dados'] as Record<string, string>;
      expect(dados['cnpjBuscado']).toBe(CNPJ_DIGITOS);
    } finally {
      registrarExtratorTextoPdf(async () => TEXTO_ALVARA);
      await fechar();
    }
  });

  it('prossegue com sucesso quando a geração de artefatos falha', { timeout: 90000 }, async () => {
    const { sessao, fechar } = await abrirSessao();
    const diretorio = path.join(
      tmpdir(),
      'api-sefaz-ssa',
      `alvara-funcionamento-${CNPJ_DIGITOS}-${CGA_DIGITOS}`,
    );
    await rm(diretorio, { recursive: true, force: true });
    await mkdir(path.dirname(diretorio), { recursive: true });
    await writeFile(diretorio, 'bloqueio');
    const avisos: Array<string | undefined> = [];
    const deixar = obterCanalProgresso().observar('exe_artefatos_falham', (evento) => {
      avisos.push(evento.etapa);
    });
    try {
      await servirPortal(sessao, formHtml, 'pdf');
      const resultado = await executarAlvaraFuncionamento(
        montarExecucao('exe_artefatos_falham', {
          cnpj: CNPJ_DIGITOS,
          inscricaoMunicipal: CGA_DIGITOS,
          artefatos: 'ambos',
        }),
        sessao,
      );
      expect(resultado['sucesso']).toBe(true);
      const dados = resultado['dados'] as Record<string, string>;
      expect(dados['razaoSocial']).toBe('EMPRESA EXEMPLO LTDA');
      expect(avisos.some((etapa) => etapa?.includes('Falha ao gerar artefatos'))).toBe(true);
    } finally {
      deixar();
      await rm(diretorio, { force: true });
      await fechar();
    }
  });

  it(
    'falha na extração com etapa rica quando a porta OCR não tem extrator',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      removerExtratorTextoPdf();
      try {
        await servirPortal(sessao, formHtml, 'pdf');
        let erro: unknown = null;
        try {
          await executarAlvaraFuncionamento(
            montarExecucao('exe_sem_ocr', { cnpj: CNPJ_DIGITOS, inscricaoMunicipal: CGA_DIGITOS }),
            sessao,
          );
        } catch (e) {
          erro = e;
        }
        expect(erro).toBeInstanceOf(EtapaError);
        expect((erro as EtapaError).etapa).toBe('extrair-dados');
      } finally {
        registrarExtratorTextoPdf(async () => TEXTO_ALVARA);
        await fechar();
      }
    },
  );
});
