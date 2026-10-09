import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DamTffTllRobot,
  executarDamTffTll,
} from '../../src/automations/sites/dam-tff-tll/dam-tff-tll.robot.js';
import {
  diretorioArtefatosExecucao,
  type ExecucaoCtx,
} from '../../src/automations/base/base-robot.js';
import type { Execucao } from '../../src/database/index.js';
import type { BrowserSession } from '../../src/modules/browser/browser.types.js';
import { obterExecutor } from '../../src/modules/jobs/executor.js';
import { obterCanalProgresso } from '../../src/modules/jobs/progresso.js';
import { EtapaError, ValidationError } from '../../src/shared/errors/index.js';

const CGA = '1234567890123';
const EXERCICIO = '2026';
const BOLETO_BASE64 =
  'JVBERi0xLjQKMSAwIG9iajw8Lz4+ZW5kb2JqCnRyYWlsZXI8PC9Sb290IDEgMCBSPj4KJSVFT0Y=';
const BOLETO_BASE64_COTA2 = 'JVBERi0xLjQgY290YTIgZGFtLXRmZi10bGwgdGVzdGU=';

const VENCIMENTOS_MULTICOTA: Record<string, { vencimento: string; valor: string }> = {
  '0': { vencimento: '14/11/2026', valor: '100,00' },
  '1': { vencimento: '14/12/2026', valor: '200,00' },
};

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
let tunelMulticotaHtml = '';
let tunelDivpdfHtml = '';
let tunelMesmaPaginaHtml = '';
let tunelFallbackHtml = '';
let tunelFalhaCotaHtml = '';

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

function montarDamFormHtml(vencimento: string, valor: string): string {
  return [
    '<html><head><title>DAM</title></head><body>',
    '<h1>Documento de Arrecadação Municipal TFF-TLL</h1>',
    '<p>Contribuinte: PADARIA TESTE LTDA</p>',
    `<p>Vencimento: ${vencimento}</p>`,
    `<p>Valor: R$ ${valor}</p>`,
    '<p>Código de barras: 816000000001100000000001141120260001000000000001</p>',
    '<p>Autenticação mecânica no verso desta guia de recolhimento municipal.</p>',
    '</body></html>',
  ].join('');
}

interface ContadoresCircuito {
  consultas: number;
  tuneis: number;
  damforms: number;
}

async function servirCircuito(
  sessao: BrowserSession,
  circuito: {
    formulario: string | (() => string);
    tunel: string;
  },
): Promise<ContadoresCircuito> {
  const contadores: ContadoresCircuito = { consultas: 0, tuneis: 0, damforms: 0 };
  await sessao.context.route('**/servicos_DamTFF.asp', (rota) => {
    contadores.consultas += 1;
    const corpo =
      typeof circuito.formulario === 'function' ? circuito.formulario() : circuito.formulario;
    return rota.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: corpo });
  });
  await sessao.context.route(
    (url) => url.href.includes('tunel'),
    (rota) => {
      contadores.tuneis += 1;
      return rota.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: circuito.tunel,
      });
    },
  );
  await sessao.context.route(
    (url) => url.href.includes('DAMForm'),
    (rota) => {
      contadores.damforms += 1;
      const cota = new URL(rota.request().url()).searchParams.get('cota') ?? '0';
      const dados = VENCIMENTOS_MULTICOTA[cota] ?? VENCIMENTOS_MULTICOTA['0'];
      const vencimento = dados?.vencimento ?? '14/11/2026';
      const valor = dados?.valor ?? '100,00';
      return rota.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: montarDamFormHtml(vencimento, valor),
      });
    },
  );
  return contadores;
}

function montarCtxDireto(
  sessao: BrowserSession,
  artefatos: 'pdf' | 'ambos' = 'pdf',
  execucaoId = 'exe_ctx_direto',
): {
  ctx: ExecucaoCtx;
  emitido: Array<{ nivel: string; mensagem: string }>;
  arquivos: Array<{ tipo: string; caminho: string }>;
} {
  const emitido: Array<{ nivel: string; mensagem: string }> = [];
  const arquivos: Array<{ tipo: string; caminho: string }> = [];
  const ctx: ExecucaoCtx = {
    sessao,
    emitir: (nivel, mensagem) => {
      emitido.push({ nivel, mensagem });
    },
    registrarArquivo: (tipo, caminho) => {
      arquivos.push({ tipo, caminho });
    },
    artefatos,
    signal: AbortSignal.timeout(120000),
    execucaoId,
  };
  return { ctx, emitido, arquivos };
}

function boletosDoLoop(
  arquivos: Array<{ tipo: string; caminho: string }>,
  boletos: Array<Record<string, unknown>>,
): Array<{ tipo: string; caminho: string }> {
  const nomes = new Set(boletos.map((b) => String(b['arquivo'] ?? '')));
  return arquivos.filter((a) => a.tipo === 'boleto' && nomes.has(path.basename(a.caminho)));
}

beforeAll(async () => {
  navegador = await chromium.launch({ headless: true });
  formHtml = await lerFixture('dam-tff-tll-form.html');
  tunelHtml = await lerFixture('dam-tff-tll-tunel.html');
  semDividaHtml = await lerFixture('dam-tff-tll-sem-divida.html');
  tunelVazioHtml = await lerFixture('dam-tff-tll-tunel-vazio.html');
  tunelBoletoHtml = await lerFixture('dam-tff-tll-tunel-boleto.html');
  tunelMulticotaHtml = await lerFixture('dam-tff-tll-tunel-multicota.html');
  tunelDivpdfHtml = await lerFixture('dam-tff-tll-tunel-divpdf.html');
  tunelMesmaPaginaHtml = await lerFixture('dam-tff-tll-tunel-mesma-pagina.html');
  tunelFallbackHtml = await lerFixture('dam-tff-tll-tunel-fallback.html');
  tunelFalhaCotaHtml = await lerFixture('dam-tff-tll-tunel-falha-cota.html');
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

  it(
    'segue com sucesso quando a geração de artefatos falha',
    { timeout: 90000 },
    async () => {
      const destino = diretorioArtefatosExecucao('dam-tff-tll', 'exe_artefatos_falham', CGA, EXERCICIO);
      await rm(destino, { recursive: true, force: true });
      await mkdir(path.dirname(destino), { recursive: true });
      await writeFile(destino, 'bloqueio');
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirPortal(sessao, formHtml, tunelHtml);
        const espionado = vi.fn();
        const ctx: ExecucaoCtx = {
          sessao,
          emitir: (nivel, mensagem) => {
            espionado(nivel, mensagem);
          },
          registrarArquivo: () => undefined,
          artefatos: 'ambos',
          signal: AbortSignal.timeout(60000),
          execucaoId: 'exe_artefatos_falham',
        };
        const robo = new DamTffTllRobot();
        const resultado = await robo.executar({ cga: CGA, exercicio: EXERCICIO }, ctx);
        expect(resultado.sucesso).toBe(true);
        expect(resultado.dados['situacao']).toBe('EM_ABERTO');
        expect(espionado).toHaveBeenCalledWith(
          'warn',
          expect.stringMatching(/Falha ao gerar artefatos.*seguindo sem artefatos/),
        );
      } finally {
        await fechar();
        await rm(destino, { force: true });
      }
    },
  );

  it(
    'emite 2 cotas com 1 consulta quando o túnel sobrevive em nova aba',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        const contadores = await servirCircuito(sessao, {
          formulario: formHtml,
          tunel: tunelMulticotaHtml,
        });
        const { ctx, emitido, arquivos } = montarCtxDireto(sessao);
        const robo = new DamTffTllRobot();
        const resultado = await robo.executar({ cga: CGA, exercicio: EXERCICIO }, ctx);
        expect(resultado.sucesso).toBe(true);
        const boletos = resultado.dados['boletos'] as Array<Record<string, unknown>>;
        expect(boletos).toHaveLength(2);
        expect(boletos[0]).toMatchObject({ cota: '1', numeroCota: 1, ramo: 'nova-aba' });
        expect(boletos[1]).toMatchObject({ cota: '2', numeroCota: 2, ramo: 'nova-aba' });
        expect(boletosDoLoop(arquivos, boletos)).toHaveLength(2);
        expect(contadores.consultas).toBe(1);
        const avisos = emitido.filter((e) => e.nivel === 'warn').map((e) => e.mensagem);
        expect(avisos.join('\n')).not.toMatch(/Falha ao emitir/);
      } finally {
        await fechar();
      }
    },
  );

  it(
    'captura o boleto embutido por cota na mesma página e ignora quitadas',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        const contadores = await servirCircuito(sessao, {
          formulario: formHtml,
          tunel: tunelDivpdfHtml,
        });
        const { ctx, arquivos } = montarCtxDireto(sessao);
        const robo = new DamTffTllRobot();
        const resultado = await robo.executar({ cga: CGA, exercicio: EXERCICIO }, ctx);
        expect(resultado.sucesso).toBe(true);
        const boletos = resultado.dados['boletos'] as Array<Record<string, unknown>>;
        expect(boletos).toHaveLength(2);
        expect(boletos[0]).toMatchObject({ cota: '1', ramo: 'div-pdf' });
        expect(boletos[1]).toMatchObject({ cota: '2', ramo: 'div-pdf' });
        const arquivosBoleto = boletosDoLoop(arquivos, boletos);
        expect(arquivosBoleto).toHaveLength(2);
        const conteudos: string[] = [];
        for (const arquivo of arquivosBoleto) {
          conteudos.push((await readFile(arquivo.caminho)).toString('base64'));
        }
        expect(conteudos).toEqual([BOLETO_BASE64, BOLETO_BASE64_COTA2]);
        const ignoradas = resultado.dados['ignoradas'] as Array<Record<string, unknown>>;
        expect(ignoradas).toHaveLength(1);
        expect(ignoradas[0]).toMatchObject({ cota: '3', situacao: 'Quitada' });
        expect(contadores.consultas).toBe(1);
      } finally {
        await fechar();
      }
    },
  );

  it(
    'retorno mínimo recupera a segunda cota quando a emissão navega a página',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        const contadores = await servirCircuito(sessao, {
          formulario: formHtml,
          tunel: tunelMesmaPaginaHtml,
        });
        const { ctx } = montarCtxDireto(sessao);
        const robo = new DamTffTllRobot();
        const resultado = await robo.executar({ cga: CGA, exercicio: EXERCICIO }, ctx);
        expect(resultado.sucesso).toBe(true);
        const boletos = resultado.dados['boletos'] as Array<Record<string, unknown>>;
        expect(boletos).toHaveLength(2);
        expect(boletos[0]).toMatchObject({ cota: '1', ramo: 'dam-form' });
        expect(boletos[1]).toMatchObject({ cota: '2', ramo: 'dam-form' });
        expect(contadores.consultas).toBe(2);
      } finally {
        await fechar();
      }
    },
  );

  it(
    'reconsulta completa conclui quando o retorno mínimo falha',
    { timeout: 120000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        let visitas = 0;
        const contadores = await servirCircuito(sessao, {
          formulario: () => {
            visitas += 1;
            return visitas === 2 ? formHtml.replace('value="XK7Q"', 'value=""') : formHtml;
          },
          tunel: tunelMesmaPaginaHtml,
        });
        const { ctx } = montarCtxDireto(sessao);
        const robo = new DamTffTllRobot();
        const resultado = await robo.executar({ cga: CGA, exercicio: EXERCICIO }, ctx);
        expect(resultado.sucesso).toBe(true);
        const boletos = resultado.dados['boletos'] as Array<Record<string, unknown>>;
        expect(boletos).toHaveLength(2);
        expect(contadores.consultas).toBeGreaterThanOrEqual(3);
      } finally {
        await fechar();
      }
    },
  );

  it(
    'falha de um boleto emite warn e conclui com as demais cotas',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        const contadores = await servirCircuito(sessao, {
          formulario: formHtml,
          tunel: tunelFalhaCotaHtml,
        });
        const { ctx, emitido, arquivos } = montarCtxDireto(sessao);
        const robo = new DamTffTllRobot();
        const resultado = await robo.executar({ cga: CGA, exercicio: EXERCICIO }, ctx);
        expect(resultado.sucesso).toBe(true);
        const boletos = resultado.dados['boletos'] as Array<Record<string, unknown>>;
        expect(boletos).toHaveLength(1);
        expect(boletos[0]).toMatchObject({ cota: '2' });
        const falhas = resultado.dados['falhas'] as Array<Record<string, unknown>>;
        expect(falhas).toHaveLength(1);
        expect(falhas[0]).toMatchObject({ cota: '1', codigo: 'FALHA_BOLETO' });
        expect(boletosDoLoop(arquivos, boletos)).toHaveLength(1);
        const avisos = emitido.filter((e) => e.nivel === 'warn').map((e) => e.mensagem);
        expect(avisos.join('\n')).toMatch(/Falha ao emitir boleto da cota 1.*seguindo para a próxima/);
        expect(contadores.consultas).toBe(1);
      } finally {
        await fechar();
      }
    },
  );

  it(
    'fallback captura a página quando o embutido some e a tela assenta no DAM',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirCircuito(sessao, { formulario: formHtml, tunel: tunelFallbackHtml });
        const { ctx, emitido } = montarCtxDireto(sessao);
        const robo = new DamTffTllRobot();
        const resultado = await robo.executar({ cga: CGA, exercicio: EXERCICIO }, ctx);
        expect(resultado.sucesso).toBe(true);
        const boletos = resultado.dados['boletos'] as Array<Record<string, unknown>>;
        expect(boletos).toHaveLength(1);
        expect(boletos[0]).toMatchObject({ cota: '1', ramo: 'dam-form' });
        const avisos = emitido.filter((e) => e.nivel === 'warn').map((e) => e.mensagem);
        expect(avisos.join('\n')).toMatch(/capturando a página atual como boleto da cota 1/);
      } finally {
        await fechar();
      }
    },
  );

  it(
    'executor expõe um pdf por cota em aberto nos boletos',
    { timeout: 90000 },
    async () => {
      const { sessao, fechar } = await abrirSessao();
      try {
        await servirCircuito(sessao, { formulario: formHtml, tunel: tunelMulticotaHtml });
        const resultado = await executarDamTffTll(
          montarExecucao('exe_multicota_executor', {
            cga: CGA,
            exercicio: EXERCICIO,
            artefatos: 'ambos',
          }),
          sessao,
        );
        expect(resultado['sucesso']).toBe(true);
        const dados = resultado['dados'] as Record<string, unknown>;
        const boletos = dados['boletos'] as Array<Record<string, unknown>>;
        expect(boletos).toHaveLength(2);
        expect(typeof boletos[0]?.['pdfBase64']).toBe('string');
        expect(typeof boletos[1]?.['pdfBase64']).toBe('string');
        expect((boletos[0]?.['pdfBase64'] as string).startsWith('JVBERi')).toBe(true);
        expect((boletos[1]?.['pdfBase64'] as string).startsWith('JVBERi')).toBe(true);
        expect(resultado['pdfBase64']).toBe(boletos[0]?.['pdfBase64']);
        expect(typeof resultado['printBase64']).toBe('string');
      } finally {
        await fechar();
      }
    },
  );
});
