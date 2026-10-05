import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { BaseRobot, type ExecucaoCtx, type ResultadoRobot } from '../../base/base-robot.js';
import { localizarPorChave, type CadeiaSeletores } from '../../base/seletores.js';
import type { Execucao } from '../../../database/index.js';
import type { BrowserSession } from '../../../modules/browser/browser.types.js';
import { carregarPortalConfig, type PortalConfig } from '../../../modules/browser/portal-config.js';
import {
  obterCanalProgresso,
  registrarExecutor,
  type ResultadoExecutor,
} from '../../../modules/jobs/index.js';
import {
  AppError,
  EtapaError,
  TimeoutError,
  ValidationError,
} from '../../../shared/errors/index.js';

export const DAM_TFF_TLL_TIMEOUT_MS = 120000;

const TIMEOUT_NAVEGACAO_MS = 30000;
const TIMEOUT_RESULTADO_POR_TENTATIVA_MS = 5000;

const TRIBUTO_PADRAO = 'TFF-TLL';

const baseInputSchema = z.object({
  inscricaoMunicipal: z.string().optional(),
  cga: z.string().optional(),
  exercicio: z.union([z.string(), z.number()]).optional(),
});

export interface DamTffTllParams {
  inscricaoMunicipal: string;
  exercicio: string;
}

const artefatosEscolhaSchema = z.enum(['nenhum', 'pdf', 'print', 'ambos']);

type ArtefatosEscolha = z.infer<typeof artefatosEscolhaSchema>;

interface LinhaCotaBruta {
  cota: string;
  situacao: string;
  valorOriginal: string;
  valorCorrigido: string;
  vencimento: string;
}

interface TunelBruto {
  contribuinte: string;
  inscricao: string;
  cnpj: string;
  aviso: string;
  cotas: LinhaCotaBruta[];
  textoBruto: string;
}

interface ElementoPagina {
  readonly textContent: string | null;
  getAttribute(nome: string): string | null;
  querySelector(seletor: string): ElementoPagina | null;
  querySelectorAll(seletor: string): ListaNosPagina;
}

interface ListaNosPagina {
  readonly length: number;
  item(indice: number): ElementoPagina | null;
  forEach(acao: (no: ElementoPagina, indice: number) => void): void;
}

interface DocumentoPagina {
  querySelector(seletor: string): ElementoPagina | null;
  querySelectorAll(seletor: string): ListaNosPagina;
  readonly body: { readonly innerText: string } | null;
}

declare const document: DocumentoPagina;

type ArquivoRegistrado = {
  tipo: Parameters<ExecucaoCtx['registrarArquivo']>[0];
  caminho: string;
  contentType: Parameters<ExecucaoCtx['registrarArquivo']>[2];
};

let configPortal: PortalConfig | null = null;

async function obterConfigPortal(): Promise<PortalConfig> {
  if (configPortal === null) {
    configPortal = await carregarPortalConfig('dam-tff-tll');
  }
  return configPortal;
}

function extrairCadeias(config: PortalConfig): Record<string, CadeiaSeletores> {
  const bruto = (config as unknown as { seletores?: Record<string, unknown> }).seletores;
  if (typeof bruto !== 'object' || bruto === null) {
    return {};
  }
  const cadeias: Record<string, CadeiaSeletores> = {};
  for (const [chave, valor] of Object.entries(bruto)) {
    if (typeof valor !== 'object' || valor === null) {
      continue;
    }
    const candidatos = (valor as { seletores?: unknown }).seletores;
    if (!Array.isArray(candidatos)) {
      continue;
    }
    cadeias[chave] = { seletores: candidatos.filter((s) => typeof s === 'string') };
  }
  return cadeias;
}

function exigirTempo(signal: AbortSignal, etapa: string): void {
  if (signal.aborted) {
    throw new TimeoutError(`Tempo esgotado durante ${etapa}`);
  }
}

function normalizarErro(etapa: string, erro: unknown): AppError {
  if (erro instanceof EtapaError || erro instanceof TimeoutError || erro instanceof ValidationError) {
    return erro;
  }
  if (erro instanceof AppError) {
    return new EtapaError(etapa, erro.message, { cause: erro });
  }
  if (erro instanceof Error && erro.name.startsWith('Timeout')) {
    return new TimeoutError(`Tempo esgotado durante ${etapa}: ${erro.message}`);
  }
  const mensagem = erro instanceof Error ? erro.message : String(erro);
  return new EtapaError(etapa, mensagem, { cause: erro });
}

function mensagemDeErro(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

function somenteDigitos(valor: string): string {
  return valor.replace(/\D/g, '');
}

function validarEntrada(params: Record<string, unknown>): DamTffTllParams {
  const base = baseInputSchema.safeParse(params);
  if (!base.success) {
    throw new ValidationError('Parâmetros inválidos para a consulta do DAM TFF/TLL', base.error.flatten());
  }
  const inscricaoMunicipal = somenteDigitos(
    base.data.inscricaoMunicipal ?? base.data.cga ?? '',
  );
  if (inscricaoMunicipal.length < 6 || inscricaoMunicipal.length > 15) {
    throw new ValidationError('Inscrição municipal (CGA) inválida: informe de 6 a 15 dígitos');
  }
  const exercicio = somenteDigitos(String(base.data.exercicio ?? ''));
  if (!/^\d{4}$/.test(exercicio)) {
    throw new ValidationError('Exercício inválido: informe o ano com 4 dígitos');
  }
  return { inscricaoMunicipal, exercicio };
}

function detectarSemDivida(texto: string): boolean {
  return /n[ãa]o\s+h[áa]\s+d[íi]vida\s+gerada/i.test(texto.replace(/\s+/g, ' ').trim());
}

function parseValorBr(valor: string): number | null {
  const limpo = valor.replace(/\s/g, '');
  if (limpo === '' || limpo === '-' || /^\(\)$/.test(limpo)) {
    return null;
  }
  const numero = Number.parseFloat(limpo.replace(/\./g, '').replace(',', '.'));
  return Number.isNaN(numero) ? null : numero;
}

function normalizarSituacaoCota(situacao: string): 'Quitada' | 'Em aberto' {
  const texto = situacao.toUpperCase();
  if (/N[ÃA]O\s*PAGA/.test(texto)) {
    return 'Em aberto';
  }
  if (/QUITAD|PAG[AO]|LIQUIDAD|BAIXAD|ISEN/.test(texto)) {
    return 'Quitada';
  }
  return 'Em aberto';
}

function numeroDaCota(cota: string): number | null {
  if (/^Única/i.test(cota)) {
    return null;
  }
  const numero = Number.parseInt(cota, 10);
  return Number.isNaN(numero) ? null : numero;
}

function extrairTunel(): TunelBruto {
  const aplainar = (texto: string): string =>
    texto.replace(/\u00a0/g, ' ').replace(/\s{2,}/g, ' ').trim();

  const rotulos = Array.from({ length: document.querySelectorAll('.PS_label').length }, (_, i) =>
    aplainar(document.querySelectorAll('.PS_label').item(i)?.textContent ?? ''),
  );
  const apos = (prefixo: string): string => {
    const achado = rotulos.find((r) => r.startsWith(prefixo));
    return achado === undefined ? '' : achado.slice(prefixo.length).trim();
  };

  const linhas: LinhaCotaBruta[] = [];
  const tabela = document.querySelector("form[name='frmDAMIFF'] table");
  const tabelaLinhas = tabela?.querySelectorAll('tr') ?? null;
  if (tabelaLinhas !== null) {
    for (let i = 0; i < tabelaLinhas.length; i += 1) {
      const linha = tabelaLinhas.item(i);
      if (linha === null || linha.querySelector('th') !== null) {
        continue;
      }
      const celulas = linha.querySelectorAll('td');
      if (celulas.length < 4) {
        continue;
      }
      const vencimentoCelula = celulas.item(4)?.textContent ?? '';
      linhas.push({
        cota: aplainar(celulas.item(0)?.textContent ?? ''),
        situacao: aplainar(celulas.item(1)?.textContent ?? ''),
        valorOriginal: aplainar(celulas.item(2)?.textContent ?? ''),
        valorCorrigido: aplainar(celulas.item(3)?.textContent ?? ''),
        vencimento: aplainar(vencimentoCelula),
      });
    }
  }

  const aviso = aplainar(document.querySelector('.PS_MSG')?.textContent ?? '');
  const corpo = aplainar(document.body?.innerText ?? '');
  const cnpj = corpo.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/)?.[0] ?? '';

  return {
    contribuinte: apos('Contribuinte:'),
    inscricao: apos('Inscrição:'),
    cnpj,
    aviso,
    cotas: linhas,
    textoBruto: corpo,
  };
}

interface CotaNormalizada {
  cota: string;
  numeroCota: number | null;
  situacao: 'Quitada' | 'Em aberto';
  tributo: string;
  valorOriginal: number | null;
  valorCorrigido: number | null;
  vencimento: string;
}

function classificarCotas(cotas: CotaNormalizada[]): 'EM_ABERTO' | 'QUITADO' | 'SEM_COTAS' {
  if (cotas.length === 0) {
    return 'SEM_COTAS';
  }
  return cotas.some((c) => c.situacao === 'Em aberto') ? 'EM_ABERTO' : 'QUITADO';
}

function montarDados(
  entrada: DamTffTllParams,
  tunel: TunelBruto,
): { dados: Record<string, unknown>; situacao: string } {
  const cotas: CotaNormalizada[] = tunel.cotas
    .filter((l) => l.cota !== '')
    .map((l) => ({
      cota: l.cota,
      numeroCota: numeroDaCota(l.cota),
      situacao: normalizarSituacaoCota(l.situacao),
      tributo: TRIBUTO_PADRAO,
      valorOriginal: parseValorBr(l.valorOriginal),
      valorCorrigido: parseValorBr(l.valorCorrigido),
      vencimento: l.vencimento,
    }));
  const situacao = classificarCotas(cotas);
  const emAberto = cotas.filter((c) => c.situacao === 'Em aberto');
  const valorTotalAberto = emAberto.reduce(
    (soma, c) => soma + (c.valorCorrigido ?? c.valorOriginal ?? 0),
    0,
  );
  const vencimentos = emAberto.map((c) => c.vencimento).filter((v) => v !== '');
  const dados: Record<string, unknown> = {
    inscricaoMunicipal: entrada.inscricaoMunicipal,
    exercicio: entrada.exercicio,
    contribuinte: tunel.contribuinte,
    cnpj: tunel.cnpj,
    inscricao: tunel.inscricao,
    situacao,
    totalCotas: cotas.length,
    cotasEmAberto: emAberto.length,
    valorTotalAberto: Math.round(valorTotalAberto * 100) / 100,
    proximoVencimento: vencimentos.length > 0 ? vencimentos.sort()[0] : null,
    cotas,
  };
  if (tunel.aviso !== '') {
    dados['mensagemPortal'] = tunel.aviso;
  }
  return { dados, situacao };
}

export class DamTffTllRobot extends BaseRobot {
  readonly tipo = 'dam-tff-tll';
  readonly nome = 'DAM TFF/TLL';
  readonly portal = 'PREF_SALVADOR';

  async executar(params: Record<string, unknown>, ctx: ExecucaoCtx): Promise<ResultadoRobot> {
    const entrada = validarEntrada(params);
    try {
      const config = await obterConfigPortal();
      const cadeias = extrairCadeias(config);
      const pagina = ctx.sessao.page;
      this.emitir(
        ctx,
        'log',
        `Iniciando consulta DAM TFF/TLL para a CGA ${entrada.inscricaoMunicipal} exercício ${entrada.exercicio}`,
      );
      await this.navegar(pagina, ctx, config);
      await this.preencherCga(pagina, ctx, cadeias, entrada.inscricaoMunicipal);
      await this.selecionarExercicio(pagina, ctx, cadeias, entrada.exercicio);
      await this.resolverCaptcha(pagina, ctx, cadeias);
      const semDivida = await this.submeterConsulta(pagina, ctx, cadeias);
      if (semDivida !== null) {
        await this.gerarArtefatos(pagina, ctx, entrada);
        return {
          sucesso: true,
          dados: {
            inscricaoMunicipal: entrada.inscricaoMunicipal,
            exercicio: entrada.exercicio,
            situacao: 'SEM_COTAS',
            totalCotas: 0,
            cotasEmAberto: 0,
            cotas: [],
            mensagemPortal: semDivida,
          },
          mensagem: 'Não há dívida gerada no portal para o exercício selecionado.',
        };
      }
      const tunel = await this.extrairDados(pagina, ctx);
      const { dados, situacao } = montarDados(entrada, tunel);
      await this.gerarArtefatos(pagina, ctx, entrada);
      if (situacao === 'SEM_COTAS') {
        return {
          sucesso: false,
          dados: {
            inscricaoMunicipal: entrada.inscricaoMunicipal,
            exercicio: entrada.exercicio,
          },
          mensagem: 'Nenhuma cota encontrada no portal para a CGA e o exercício informados.',
        };
      }
      const total = (dados['cotasEmAberto'] as number) ?? 0;
      this.emitir(ctx, 'log', `Consulta concluída: situação ${situacao} com ${total} cota(s) em aberto`);
      return {
        sucesso: true,
        dados,
        mensagem: 'Consulta DAM TFF/TLL realizada com sucesso.',
      };
    } catch (erro) {
      this.emitir(ctx, 'error', mensagemDeErro(erro));
      throw erro;
    }
  }

  private async navegar(pagina: Page, ctx: ExecucaoCtx, config: PortalConfig): Promise<void> {
    exigirTempo(ctx.signal, 'navegar-portal');
    this.emitir(ctx, 'log', 'Acessando o portal do DAM TFF/TLL');
    try {
      await pagina.goto(config.navegacao.url, {
        waitUntil: config.navegacao.waitUntil,
        timeout: TIMEOUT_NAVEGACAO_MS,
      });
    } catch (erro) {
      throw normalizarErro('navegar-portal', erro);
    }
  }

  private async preencherCga(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
    inscricaoMunicipal: string,
  ): Promise<void> {
    exigirTempo(ctx.signal, 'preencher-cga');
    this.emitir(ctx, 'log', 'Preenchendo a Inscrição Municipal (CGA) para consulta');
    try {
      const campo = await localizarPorChave(pagina, 'campo_cga', cadeias, 'preencher-cga');
      await campo.fill('');
      await campo.fill(inscricaoMunicipal);
    } catch (erro) {
      throw normalizarErro('preencher-cga', erro);
    }
  }

  private async selecionarExercicio(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
    exercicio: string,
  ): Promise<void> {
    exigirTempo(ctx.signal, 'selecionar-exercicio');
    this.emitir(ctx, 'log', 'Selecionando o exercício para consulta');
    try {
      const campo = await localizarPorChave(pagina, 'campo_exercicio', cadeias, 'selecionar-exercicio');
      await campo.selectOption(exercicio);
    } catch (erro) {
      throw normalizarErro('selecionar-exercicio', erro);
    }
  }

  private async resolverCaptcha(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
  ): Promise<void> {
    exigirTempo(ctx.signal, 'resolver-captcha');
    this.emitir(ctx, 'log', 'Resolvendo o captcha do portal');
    try {
      const oculto = await localizarPorChave(
        pagina,
        'campo_captcha_oculto',
        cadeias,
        'resolver-captcha',
      );
      const codigo = ((await oculto.getAttribute('value')) ?? '').trim().toUpperCase();
      if (codigo === '') {
        throw new EtapaError('resolver-captcha', 'Captcha não encontrado no portal. Tente novamente.');
      }
      const visivel = await localizarPorChave(pagina, 'campo_captcha', cadeias, 'resolver-captcha');
      await visivel.fill('');
      await visivel.fill(codigo);
    } catch (erro) {
      throw normalizarErro('resolver-captcha', erro);
    }
  }

  private async submeterConsulta(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
  ): Promise<string | null> {
    exigirTempo(ctx.signal, 'submeter-consulta');
    this.emitir(ctx, 'log', 'Submetendo a consulta e aguardando o resultado');
    try {
      const botao = await localizarPorChave(pagina, 'botao_consultar', cadeias, 'submeter-consulta');
      await botao.click();
      exigirTempo(ctx.signal, 'aguardar-resultado');
      try {
        await localizarPorChave(
          pagina,
          'sinal_resultado',
          cadeias,
          'aguardar-resultado',
          TIMEOUT_RESULTADO_POR_TENTATIVA_MS,
        );
        return null;
      } catch (aguardo) {
        const texto = await pagina.evaluate(() => document.body?.innerText ?? '').catch(() => '');
        if (detectarSemDivida(texto)) {
          return texto.replace(/\s+/g, ' ').trim().slice(0, 400);
        }
        throw aguardo;
      }
    } catch (erro) {
      throw normalizarErro('aguardar-resultado', erro);
    }
  }

  private async extrairDados(pagina: Page, ctx: ExecucaoCtx): Promise<TunelBruto> {
    exigirTempo(ctx.signal, 'extrair-dados');
    this.emitir(ctx, 'log', 'Extraindo os dados do DAM');
    try {
      return await pagina.evaluate(extrairTunel);
    } catch (erro) {
      throw normalizarErro('extrair-dados', erro);
    }
  }

  private async lerBoletoEmbutido(pagina: Page): Promise<Buffer | null> {
    const presente = await pagina.locator('#pdfID').count().catch(() => 0);
    if (presente === 0) {
      return null;
    }
    const src = await pagina
      .locator('#pdfID')
      .first()
      .getAttribute('src', { timeout: TIMEOUT_RESULTADO_POR_TENTATIVA_MS })
      .catch(() => null);
    if (src === null || !src.includes('base64,')) {
      return null;
    }
    const base64 = src.slice(src.indexOf('base64,') + 7).trim();
    if (base64 === '') {
      return null;
    }
    return Buffer.from(base64, 'base64');
  }

  private async gerarArtefatos(
    pagina: Page,
    ctx: ExecucaoCtx,
    entrada: DamTffTllParams,
  ): Promise<void> {
    exigirTempo(ctx.signal, 'gerar-artefatos');
    if (ctx.artefatos === 'nenhum') {
      return;
    }
    this.emitir(ctx, 'log', 'Gerando os artefatos da consulta');
    try {
      const diretorio = path.join(
        tmpdir(),
        'api-sefaz-ssa',
        `dam-tff-tll-${entrada.inscricaoMunicipal}-${entrada.exercicio}`,
      );
      await mkdir(diretorio, { recursive: true });
      if (ctx.artefatos === 'print' || ctx.artefatos === 'ambos') {
        const print = await pagina.screenshot({ type: 'jpeg', quality: 70, fullPage: true });
        const caminhoPrint = path.join(diretorio, 'print.jpg');
        await writeFile(caminhoPrint, print);
        ctx.registrarArquivo('print', caminhoPrint, 'image/jpeg');
      }
      if (ctx.artefatos === 'pdf' || ctx.artefatos === 'ambos') {
        const boleto = await this.lerBoletoEmbutido(pagina);
        if (boleto !== null) {
          const caminhoBoleto = path.join(diretorio, 'boleto.pdf');
          await writeFile(caminhoBoleto, boleto);
          ctx.registrarArquivo('boleto', caminhoBoleto, 'application/pdf');
        } else {
          const pdf = await pagina.pdf({ format: 'A4', printBackground: true });
          const caminhoPdf = path.join(diretorio, 'pagina.pdf');
          await writeFile(caminhoPdf, pdf);
          ctx.registrarArquivo('pdf_pagina', caminhoPdf, 'application/pdf');
        }
      }
    } catch (erro) {
      throw normalizarErro('gerar-artefatos', erro);
    }
  }
}

function validarPayload(payload: string): { entrada: DamTffTllParams; artefatos: ArtefatosEscolha } {
  let bruto: unknown;
  try {
    bruto = JSON.parse(payload) as unknown;
  } catch {
    throw new ValidationError('Payload da execução inválido: JSON malformado');
  }
  if (typeof bruto !== 'object' || bruto === null) {
    throw new ValidationError('Payload da execução inválido: objeto esperado');
  }
  const registro = bruto as Record<string, unknown>;
  const entrada = validarEntrada(registro);
  const artefatos = artefatosEscolhaSchema.safeParse(registro['artefatos'] ?? 'nenhum');
  if (!artefatos.success) {
    throw new ValidationError('Opção de artefatos inválida: use nenhum, pdf, print ou ambos');
  }
  return { entrada, artefatos: artefatos.data };
}

export const executarDamTffTll = async (
  execucao: Execucao,
  sessao: BrowserSession,
): Promise<ResultadoExecutor> => {
  const { entrada, artefatos } = validarPayload(execucao.payload);
  const canal = obterCanalProgresso();
  const robo = new DamTffTllRobot();
  const arquivos: ArquivoRegistrado[] = [];
  const ctx: ExecucaoCtx = {
    sessao,
    emitir: (_nivel, mensagem) => {
      canal.publicar({
        execucaoId: execucao.id,
        status: 'RUNNING',
        posicaoFila: null,
        etapa: mensagem,
        tentativa: execucao.attempts,
      });
    },
    registrarArquivo: (tipo, caminho, contentType) => {
      arquivos.push({ tipo, caminho, contentType });
    },
    artefatos,
    signal: AbortSignal.timeout(DAM_TFF_TLL_TIMEOUT_MS),
  };
  const resultado = await robo.executar(
    { inscricaoMunicipal: entrada.inscricaoMunicipal, exercicio: entrada.exercicio },
    ctx,
  );
  const saida: Record<string, unknown> = { sucesso: resultado.sucesso, dados: resultado.dados };
  if (resultado.mensagem !== undefined) {
    saida['mensagem'] = resultado.mensagem;
  }
  for (const arquivo of arquivos) {
    const conteudo = await readFile(arquivo.caminho);
    if (arquivo.tipo === 'print') {
      saida['printBase64'] = conteudo.toString('base64');
    }
    if (arquivo.tipo === 'pdf_pagina' || arquivo.tipo === 'boleto') {
      saida['pdfBase64'] = conteudo.toString('base64');
    }
  }
  return saida;
};

registrarExecutor('dam-tff-tll', executarDamTffTll);
