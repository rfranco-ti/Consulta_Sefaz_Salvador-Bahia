import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { obterExtratorTextoPdf, registrarExtratorTextoPdf, removerExtratorTextoPdf } from '../../src/automations/base/ocr.js';
import {
  analisarTextoFicha,
  executarFichaCadastral,
  fichaCadastralInputSchema,
} from '../../src/automations/sites/ficha-cadastral/ficha-cadastral.robot.js';
import type { Execucao } from '../../src/database/index.js';
import type { BrowserSession } from '../../src/modules/browser/browser.types.js';
import { obterExecutor } from '../../src/modules/jobs/executor.js';
import { obterCanalProgresso } from '../../src/modules/jobs/progresso.js';
import { EtapaError, InternalError, ValidationError } from '../../src/shared/errors/index.js';

const CNPJ_MASCARA = '12.345.678/0001-95';
const CNPJ_DIGITOS = '12345678000195';

const TEXTO_FICHA = [
  'Razão Social: EMPRESA EXEMPLO LTDA',
  'Nome Fantasia: LOJA EXEMPLO',
  'CNPJ: 12.345.678/0001-95',
  'Inscrição Municipal (CGA): 1234567',
  'Situação Cadastral: ATIVA',
  'Data Inscrição na Prefeitura: 10/05/2010',
  'Tipo de Unidade: LOJA',
  'Forma de Atuação: ESTABELECIMENTO FIXO',
  'Tipo de Constituição: MATRIZ',
  'Natureza Jurídica: SOCIEDADE EMPRESARIA LIMITADA',
  'Nº do TVL: 98765',
  'Validade TVL: 31/12/2026',
  'Logradouro: RUA DAS FLORES',
  'Número: 100',
  'Complemento: SALA 101',
  'Bairro: CENTRO',
  'CEP: 40000000',
  'Telefone: (71) 3333-4444',
  'Correio Eletrônico: contato@exemplo.com.br',
  'CNAE Principal: 4711-3/01 COMERCIO VAREJISTA',
  'Data Início: 10/05/2010',
  'Observações: NADA CONSTA',
].join('\n');

const CNPJ_DIVERGENTE_DIGITOS = '11222333000181';

const TEXTO_FICHA_CNPJ_DIVERGENTE = TEXTO_FICHA.replace('12.345.678/0001-95', '11.222.333/0001-81');

const TEXTO_FICHA_SEM_CNPJ = [
  'Razão Social: EMPRESA EXEMPLO LTDA',
  'Nome Fantasia: LOJA EXEMPLO',
  'Situação Cadastral: ATIVA',
  'Logradouro: RUA DAS FLORES',
  'Número: 100',
  'Bairro: CENTRO',
].join('\n');

const PDF_OFICIAL = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf-8');

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

function montarExecucao(id: string, carga: unknown): Execucao {
  const texto = typeof carga === 'string' ? carga : JSON.stringify(carga);
  return {
    id,
    tipo: 'ficha-cadastral',
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
  destino: Buffer | string,
): Promise<void> {
  await sessao.page.route('**/AlvaraCgaEmissaoFichaResumidaFrm.aspx', (rota) =>
    rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: formulario }),
  );
  await sessao.page.route('**/ficha-cadastral.pdf*', (rota) => {
    if (Buffer.isBuffer(destino)) {
      return rota.fulfill({
        status: 200,
        contentType: 'application/pdf',
        headers: { 'Content-Disposition': 'attachment; filename="ficha-cadastral.pdf"' },
        body: destino,
      });
    }
    return rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: destino });
  });
}

function comOcrFalso(): () => void {
  registrarExtratorTextoPdf(async (caminho) => {
    const conteudo = await readFile(caminho);
    expect(conteudo.length).toBeGreaterThan(0);
    expect(caminho.endsWith('.pdf')).toBe(true);
    return TEXTO_FICHA;
  });
  return () => removerExtratorTextoPdf();
}

beforeAll(async () => {
  navegador = await chromium.launch({ headless: true });
  formHtml = await lerFixture('ficha-cadastral-form.html');
  erroHtml = await lerFixture('ficha-cadastral-erro.html');
}, 60000);

afterAll(async () => {
  await navegador.close();
});

describe('robot ficha-cadastral', () => {
  it('registra seu executor no carregamento do módulo', () => {
    expect(obterExecutor('ficha-cadastral')).toBe(executarFichaCadastral);
  });

  it('aceita CNPJ com máscara e normaliza para dígitos', () => {
    const parsed = fichaCadastralInputSchema.safeParse({ cnpj: CNPJ_MASCARA });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.cnpj).toBe(CNPJ_DIGITOS);
    }
  });

  it('converte o texto do PDF em campos da ficha', () => {
    const campos = analisarTextoFicha(TEXTO_FICHA);
    expect(campos['razaoSocial']).toBe('EMPRESA EXEMPLO LTDA');
    expect(campos['inscricaoMunicipal']).toBe('1234567');
    expect(campos['situacaoCadastral']).toBe('ATIVA');
    expect(campos['numeroTVL']).toBe('98765');
    expect(campos['email']).toBe('contato@exemplo.com.br');
  });

  it(
    'rejeita CNPJ inválido com ValidationError antes de tocar no navegador',
    { timeout: 60000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await expect(
          executarFichaCadastral(montarExecucao('exe_ficha_invalido', { cnpj: '123' }), sessao),
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
          executarFichaCadastral(montarExecucao('exe_payload_ruim', 'não-json{'), sessao),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(sessao.page.url()).toBe('about:blank');
      } finally {
        await fechar();
      }
    },
  );

  it(
    'executa o fluxo completo offline com PDF oficial, OCR falso e artefatos',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      const limparOcr = comOcrFalso();
      try {
        await servirPortal(sessao, formHtml, PDF_OFICIAL);
        const etapas: Array<string | undefined> = [];
        const deixar = obterCanalProgresso().observar('exe_fluxo_feliz', (evento) => {
          etapas.push(evento.etapa);
        });
        try {
          const resultado = await executarFichaCadastral(
            montarExecucao('exe_fluxo_feliz', { cnpj: CNPJ_MASCARA, artefatos: 'ambos' }),
            sessao,
          );
          expect(resultado['sucesso']).toBe(true);
          const dados = resultado['dados'] as Record<string, string>;
          expect(dados['cnpjBuscado']).toBe(CNPJ_DIGITOS);
          expect(dados['cnpj']).toBe(CNPJ_DIGITOS);
          expect(dados['inscricaoMunicipal']).toBe('1234567');
          expect(dados['razaoSocial']).toBe('EMPRESA EXEMPLO LTDA');
          expect(dados['nomeFantasia']).toBe('LOJA EXEMPLO');
          expect(dados['situacaoCadastral']).toBe('ATIVA');
          expect(dados['formaAtuacao']).toBe('ESTABELECIMENTO FIXO');
          expect(dados['logradouro']).toBe('RUA DAS FLORES');
          expect(dados['bairro']).toBe('CENTRO');
          expect(dados['cep']).toBe('40000-000');
          expect(dados['email']).toBe('contato@exemplo.com.br');
          expect(dados['cnaePrincipal']).toBe('4711-3/01 COMERCIO VAREJISTA');
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
        limparOcr();
        await fechar();
      }
    },
  );

  it(
    'não gera artefatos quando artefatos é nenhum',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      const limparOcr = comOcrFalso();
      try {
        await servirPortal(sessao, formHtml, PDF_OFICIAL);
        const resultado = await executarFichaCadastral(
          montarExecucao('exe_sem_artefatos', { cnpj: CNPJ_DIGITOS }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(true);
        expect(resultado['printBase64']).toBeUndefined();
        expect(resultado['pdfBase64']).toBeUndefined();
      } finally {
        limparOcr();
        await fechar();
      }
    },
  );

  it(
    'usa o fallback por name quando o id do campo some',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      const limparOcr = comOcrFalso();
      try {
        const formSemId = formHtml.replace(
          'id="ctl00_ContentPlaceHolderPrincipal_txtNuCnpj" ',
          '',
        );
        await servirPortal(sessao, formSemId, PDF_OFICIAL);
        const resultado = await executarFichaCadastral(
          montarExecucao('exe_fallback', { cnpj: CNPJ_DIGITOS }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(true);
        const dados = resultado['dados'] as Record<string, string>;
        expect(dados['inscricaoMunicipal']).toBe('1234567');
      } finally {
        limparOcr();
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
        await servirPortal(sessao, formSemCampo, PDF_OFICIAL);
        let erro: unknown = null;
        try {
          await executarFichaCadastral(montarExecucao('exe_sem_campo', { cnpj: CNPJ_DIGITOS }), sessao);
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
    'retorna sucesso falso com mensagem em português quando o portal rejeita o CNPJ',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      const limparOcr = comOcrFalso();
      try {
        await servirPortal(sessao, formHtml, erroHtml);
        const resultado = await executarFichaCadastral(
          montarExecucao('exe_nao_encontrado', { cnpj: CNPJ_DIGITOS }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(false);
        expect(String(resultado['mensagem'])).toMatch(/não encontrada/);
      } finally {
        limparOcr();
        await fechar();
      }
    },
  );

  it('retorna sucesso falso quando o CNPJ do documento diverge do buscado', { timeout: 90000 }, async () => {
    const { sessao, fechar } = await abrirSessao();
    registrarExtratorTextoPdf(async () => TEXTO_FICHA_CNPJ_DIVERGENTE);
    try {
      await servirPortal(sessao, formHtml, PDF_OFICIAL);
      const resultado = await executarFichaCadastral(
        montarExecucao('exe_cnpj_divergente', { cnpj: CNPJ_DIGITOS }),
        sessao,
      );
      expect(resultado['sucesso']).toBe(false);
      expect(String(resultado['mensagem'])).toContain(CNPJ_DIVERGENTE_DIGITOS);
      expect(String(resultado['mensagem'])).toContain(CNPJ_DIGITOS);
      const dados = resultado['dados'] as Record<string, string>;
      expect(dados['cnpjBuscado']).toBe(CNPJ_DIGITOS);
      expect(dados['cnpjEncontrado']).toBe(CNPJ_DIVERGENTE_DIGITOS);
    } finally {
      removerExtratorTextoPdf();
      await fechar();
    }
  });

  it('mantém o gate por inscrição municipal quando o CNPJ extraído está vazio', { timeout: 90000 }, async () => {
    const { sessao, fechar } = await abrirSessao();
    registrarExtratorTextoPdf(async () => TEXTO_FICHA_SEM_CNPJ);
    try {
      await servirPortal(sessao, formHtml, PDF_OFICIAL);
      const resultado = await executarFichaCadastral(
        montarExecucao('exe_cnpj_vazio', { cnpj: CNPJ_DIGITOS }),
        sessao,
      );
      expect(resultado['sucesso']).toBe(false);
      expect(String(resultado['mensagem'])).toMatch(/não encontrada/);
      expect(String(resultado['mensagem'])).not.toContain('refere-se');
      const dados = resultado['dados'] as Record<string, string>;
      expect(dados['cnpjBuscado']).toBe(CNPJ_DIGITOS);
    } finally {
      removerExtratorTextoPdf();
      await fechar();
    }
  });

  it('prossegue com sucesso quando a geração de artefatos falha', { timeout: 90000 }, async () => {
    const { sessao, fechar } = await abrirSessao();
    const limparOcr = comOcrFalso();
    const diretorio = path.join(tmpdir(), 'api-sefaz-ssa', `ficha-cadastral-${CNPJ_DIGITOS}`);
    await rm(diretorio, { recursive: true, force: true });
    await mkdir(path.dirname(diretorio), { recursive: true });
    await writeFile(diretorio, 'bloqueio');
    const avisos: Array<string | undefined> = [];
    const deixar = obterCanalProgresso().observar('exe_artefatos_falham', (evento) => {
      avisos.push(evento.etapa);
    });
    try {
      await servirPortal(sessao, formHtml, PDF_OFICIAL);
      const resultado = await executarFichaCadastral(
        montarExecucao('exe_artefatos_falham', { cnpj: CNPJ_DIGITOS, artefatos: 'ambos' }),
        sessao,
      );
      expect(resultado['sucesso']).toBe(true);
      const dados = resultado['dados'] as Record<string, string>;
      expect(dados['inscricaoMunicipal']).toBe('1234567');
      expect(avisos.some((etapa) => etapa?.includes('Falha ao gerar artefatos'))).toBe(true);
    } finally {
      deixar();
      await rm(diretorio, { force: true });
      limparOcr();
      await fechar();
    }
  });

  it('porta OCR lança erro interno em português quando nenhum extrator foi registrado', async () => {
    removerExtratorTextoPdf();
    try {
      const extrair = obterExtratorTextoPdf();
      await expect(extrair('/tmp/ficha-inexistente.pdf')).rejects.toBeInstanceOf(InternalError);
      await expect(extrair('/tmp/ficha-inexistente.pdf')).rejects.toThrow(/não implementado/);
    } finally {
      removerExtratorTextoPdf();
    }
  });
});
