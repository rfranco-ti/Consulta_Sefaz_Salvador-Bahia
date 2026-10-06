import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  limparResolvedorCaptcha,
  registrarResolvedorCaptcha,
  resolverCaptcha,
} from '../../src/automations/base/captcha.js';
import { detectarCaptchaImagem } from '../../src/automations/base/captcha/detector.js';
import {
  executarCadinSalvador,
  cadinSalvadorInputSchema,
  montarRelatorioCadinHtml,
} from '../../src/automations/sites/cadin-salvador/cadin-salvador.robot.js';
import type { Execucao } from '../../src/database/index.js';
import type { BrowserSession } from '../../src/modules/browser/browser.types.js';
import { obterExecutor } from '../../src/modules/jobs/executor.js';
import { obterCanalProgresso } from '../../src/modules/jobs/progresso.js';
import { EtapaError, InternalError, ValidationError } from '../../src/shared/errors/index.js';

const CNPJ_MASCARA = '12.345.678/0001-95';
const CNPJ_DIGITOS = '12345678000195';
const CPF_MASCARA = '123.456.789-09';
const CPF_DIGITOS = '12345678909';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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
let resultadoSemPendenciaHtml = '';

function montarExecucao(id: string, carga: unknown): Execucao {
  const texto = typeof carga === 'string' ? carga : JSON.stringify(carga);
  return {
    id,
    tipo: 'cadin-salvador',
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
  await sessao.page.route('**/default.aspx', (rota) =>
    rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: formulario }),
  );
  await sessao.page.route(
    (url) => url.href.includes('resultado.aspx'),
    (rota) => rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: resultado }),
  );
  await sessao.page.route('**/CaptchaImage.aspx*', (rota) =>
    rota.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX }),
  );
}

function registrarCaptchaFake(capturados: string[]): void {
  registrarResolvedorCaptcha(async (caminhoImagem) => {
    capturados.push(caminhoImagem);
    return 'AB12';
  });
}

beforeAll(async () => {
  navegador = await chromium.launch({ headless: true });
  formHtml = await lerFixture('cadin-salvador-form.html');
  resultadoHtml = await lerFixture('cadin-salvador-resultado.html');
  resultadoSemPendenciaHtml = await lerFixture('cadin-salvador-resultado-sem-pendencia.html');
}, 60000);

beforeEach(() => {
  limparResolvedorCaptcha();
});

afterAll(async () => {
  limparResolvedorCaptcha();
  await navegador.close();
});

describe('porta captcha', () => {
  it('lança InternalError em português quando nenhum resolvedor foi registrado', async () => {
    await expect(resolverCaptcha('/tmp/captcha.png')).rejects.toBeInstanceOf(InternalError);
    await expect(resolverCaptcha('/tmp/captcha.png')).rejects.toThrow(
      'resolvedor de captcha não implementado',
    );
  });

  it('delega para o resolvedor injetado', async () => {
    registrarResolvedorCaptcha(async (caminho) => `lido:${caminho}`);
    await expect(resolverCaptcha('/tmp/captcha.png')).resolves.toBe('lido:/tmp/captcha.png');
  });
});

describe('detector de captcha', () => {
  it(
    'retorna o handle da imagem no formulário do cadin',
    { timeout: 60000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await sessao.page.setContent(formHtml);
        const handle = await detectarCaptchaImagem(sessao.page, [
          "img[src*='CaptchaImage.aspx']",
        ]);
        expect(handle).not.toBeNull();
        await handle?.dispose();
      } finally {
        await fechar();
      }
    },
  );

  it(
    'usa o seletor genérico quando a cadeia do portal está vazia',
    { timeout: 60000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await sessao.page.setContent('<html><body><img src="captcha123.png"></body></html>');
        const handle = await detectarCaptchaImagem(sessao.page, []);
        expect(handle).not.toBeNull();
        await handle?.dispose();
      } finally {
        await fechar();
      }
    },
  );

  it(
    'retorna nulo quando a página não tem imagem de captcha',
    { timeout: 60000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await sessao.page.setContent('<html><body><p>Sem captcha aqui</p></body></html>');
        const handle = await detectarCaptchaImagem(sessao.page, [
          "img[src*='CaptchaImage.aspx']",
        ]);
        expect(handle).toBeNull();
      } finally {
        await fechar();
      }
    },
  );
});

describe('robot cadin-salvador', () => {
  it('registra seu executor no carregamento do módulo', () => {
    expect(obterExecutor('cadin-salvador')).toBe(executarCadinSalvador);
  });

  it('aceita CNPJ com máscara e classifica como PJ', () => {
    const parsed = cadinSalvadorInputSchema.safeParse({ cnpj: CNPJ_MASCARA });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.documento).toBe(CNPJ_DIGITOS);
      expect(parsed.data.tipoDocumento).toBe('PJ');
    }
  });

  it('aceita CPF com máscara e classifica como PF', () => {
    const parsed = cadinSalvadorInputSchema.safeParse({ cpf: CPF_MASCARA });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.documento).toBe(CPF_DIGITOS);
      expect(parsed.data.tipoDocumento).toBe('PF');
    }
  });

  it(
    'rejeita documento inválido com ValidationError antes de tocar no navegador',
    { timeout: 60000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await expect(
          executarCadinSalvador(montarExecucao('exe_doc_invalido', { documento: '123' }), sessao),
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
          executarCadinSalvador(montarExecucao('exe_payload_ruim', 'não-json{'), sessao),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(sessao.page.url()).toBe('about:blank');
      } finally {
        await fechar();
      }
    },
  );

  it(
    'executa o fluxo completo offline com captcha fake e gera relatório de template fixo',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirPortal(sessao, formHtml, resultadoHtml);
        const capturados: string[] = [];
        registrarCaptchaFake(capturados);
        const etapas: Array<string | undefined> = [];
        const deixar = obterCanalProgresso().observar('exe_fluxo_feliz', (evento) => {
          etapas.push(evento.etapa);
        });
        try {
          const resultado = await executarCadinSalvador(
            montarExecucao('exe_fluxo_feliz', { documento: CNPJ_MASCARA, artefatos: 'ambos' }),
            sessao,
          );
          expect(capturados).toHaveLength(1);
          expect(capturados[0]).toMatch(/captcha\.png$/);
          expect(resultado['sucesso']).toBe(true);
          const dados = resultado['dados'] as Record<string, unknown>;
          expect(dados['numeroDocumento']).toBe(CNPJ_DIGITOS);
          expect(dados['tipoDocumento']).toBe('PJ');
          expect(dados['nome']).toBe('EMPRESA EXEMPLO LTDA');
          expect(dados['temPendencias']).toBe(true);
          expect(dados['totalPendencias']).toBe(2);
          expect(dados['valorTotal']).toBe(1802.45);
          const pendencias = dados['pendencias'] as Array<Record<string, unknown>>;
          expect(pendencias).toHaveLength(2);
          expect(pendencias[0]).toMatchObject({ tipo: 'IPTU', vencimento: '31/01/2026' });
          expect(resultado['mensagem']).toMatch(/sucesso/);
          expect(typeof resultado['printBase64']).toBe('string');
          expect((resultado['printBase64'] as string).startsWith('/9j')).toBe(true);
          expect(typeof resultado['pdfBase64']).toBe('string');
          expect((resultado['pdfBase64'] as string).startsWith('JVBERi')).toBe(true);
          expect(etapas.length).toBeGreaterThan(3);
          expect(etapas.some((etapa) => etapa?.includes('captcha'))).toBe(true);
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
        registrarCaptchaFake([]);
        const resultado = await executarCadinSalvador(
          montarExecucao('exe_sem_artefatos', { documento: CNPJ_DIGITOS }),
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
          'id="ctl00_ContentPlaceHolder1_TxtNumDocumento"',
          'placeholder="Documento"',
        );
        await servirPortal(sessao, formSemId, resultadoHtml);
        registrarCaptchaFake([]);
        const resultado = await executarCadinSalvador(
          montarExecucao('exe_fallback', { documento: CNPJ_DIGITOS }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(true);
        const dados = resultado['dados'] as Record<string, unknown>;
        expect(dados['nome']).toBe('EMPRESA EXEMPLO LTDA');
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
          '<p>Documento: <input type="text" name="ctl00$ContentPlaceHolder1$TxtNumDocumento" id="ctl00_ContentPlaceHolder1_TxtNumDocumento" maxlength="18" /></p>',
          '',
        );
        await servirPortal(sessao, formSemCampo, resultadoHtml);
        registrarCaptchaFake([]);
        let erro: unknown = null;
        try {
          await executarCadinSalvador(montarExecucao('exe_sem_campo', { documento: CNPJ_DIGITOS }), sessao);
        } catch (e) {
          erro = e;
        }
        expect(erro).toBeInstanceOf(EtapaError);
        expect((erro as EtapaError).etapa).toBe('preencher-documento');
        expect((erro as Error).message).toContain('campo_documento');
        expect((erro as Error).message).toContain('#ctl00_ContentPlaceHolder1_TxtNumDocumento');
      } finally {
        await fechar();
      }
    },
  );

  it(
    'retorna sucesso falso com mensagem em português quando não há pendências',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirPortal(sessao, formHtml, resultadoSemPendenciaHtml);
        registrarCaptchaFake([]);
        const resultado = await executarCadinSalvador(
          montarExecucao('exe_sem_pendencia', { documento: CNPJ_DIGITOS, artefatos: 'ambos' }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(false);
        expect(String(resultado['mensagem'])).toMatch(/Nenhuma pendência/);
        const dados = resultado['dados'] as Record<string, unknown>;
        expect(dados['numeroDocumento']).toBe(CNPJ_DIGITOS);
        expect(typeof resultado['pdfBase64']).toBe('string');
      } finally {
        await fechar();
      }
    },
  );

  it(
    'retorna sucesso falso com mensagem em português quando o documento não é encontrado',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        const resultadoVazio = resultadoHtml.replace(
          'Constam PENDÊNCIAS no CADIN Municipal para o documento informado.',
          '',
        );
        await servirPortal(sessao, formHtml, resultadoVazio);
        registrarCaptchaFake([]);
        const resultado = await executarCadinSalvador(
          montarExecucao('exe_nao_encontrado', { documento: CNPJ_DIGITOS }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(false);
        expect(String(resultado['mensagem'])).toMatch(/não encontrado/);
      } finally {
        await fechar();
      }
    },
  );

  it('monta o relatório com template fixo a partir dos dados extraídos', () => {
    const base = {
      tipoDocumento: 'PJ',
      numeroDocumento: CNPJ_DIGITOS,
      nome: 'EMPRESA EXEMPLO LTDA',
      cpfCnpj: CNPJ_MASCARA,
      totalPendencias: 1,
      valorTotal: 'R$ 1.234,56',
      dataConsulta: '05/10/2026',
      mensagemPortal: 'Constam PENDÊNCIAS no CADIN Municipal.',
    };
    const comPendencias = montarRelatorioCadinHtml({
      ...base,
      pendencias: [
        { tipo: 'IPTU', descricao: 'Débito de IPTU', valor: '1.234,56', vencimento: '31/01/2026', situacao: 'Em aberto' },
      ],
    });
    expect(comPendencias).toContain('EMPRESA EXEMPLO LTDA');
    expect(comPendencias).toContain(CNPJ_DIGITOS);
    expect(comPendencias).toContain('IPTU');
    expect(comPendencias).toContain('R$ 1.234,56');
    const semPendencias = montarRelatorioCadinHtml({ ...base, totalPendencias: 0, pendencias: [] });
    expect(semPendencias).toContain('NENHUMA PENDÊNCIA ENCONTRADA');
    expect(semPendencias).toContain(CNPJ_DIGITOS);
  });
});
