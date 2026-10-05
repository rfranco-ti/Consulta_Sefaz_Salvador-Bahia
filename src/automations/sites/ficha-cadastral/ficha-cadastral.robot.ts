import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { BaseRobot, type ExecucaoCtx, type ResultadoRobot } from '../../base/base-robot.js';
import {
  analisarTextoComRotulos,
  formatarCep,
  lerErroPortal as lerErroPortalCompartilhado,
  mensagemDivergenciaCnpj,
  somenteDigitos,
} from '../../base/extracao-texto.js';
import { obterExtratorTextoPdf, type ExtratorTextoPdf } from '../../base/ocr.js';
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

export const FICHA_CADASTRAL_TIMEOUT_MS = 120000;

const TIMEOUT_NAVEGACAO_MS = 30000;
const TIMEOUT_DOWNLOAD_MS = 8000;

export const fichaCadastralInputSchema = z.object({
  cnpj: z
    .string()
    .transform((valor) => valor.replace(/\D/g, ''))
    .refine((valor) => valor.length === 14, 'CNPJ inválido: deve conter 14 dígitos'),
});

export type FichaCadastralParams = z.infer<typeof fichaCadastralInputSchema>;

const artefatosEscolhaSchema = z.enum(['nenhum', 'pdf', 'print', 'ambos']);

type ArtefatosEscolha = z.infer<typeof artefatosEscolhaSchema>;

type ArquivoRegistrado = {
  tipo: Parameters<ExecucaoCtx['registrarArquivo']>[0];
  caminho: string;
  contentType: Parameters<ExecucaoCtx['registrarArquivo']>[2];
};

const ROTULOS_FICHA: Array<readonly [string, string]> = [
  ['razao social', 'razaoSocial'],
  ['nome fantasia', 'nomeFantasia'],
  ['cnpj', 'cnpj'],
  ['inscricao municipal (cga)', 'inscricaoMunicipal'],
  ['inscricao municipal', 'inscricaoMunicipal'],
  ['cga', 'inscricaoMunicipal'],
  ['situacao cadastral', 'situacaoCadastral'],
  ['data inscricao na prefeitura', 'dataInscricaoPrefeitura'],
  ['tipo de unidade', 'tipoUnidade'],
  ['forma de atuacao', 'formaAtuacao'],
  ['tipo de constituicao', 'tipoConstituicao'],
  ['natureza juridica', 'naturezaJuridica'],
  ['nº do tvl', 'numeroTVL'],
  ['n° do tvl', 'numeroTVL'],
  ['validade tvl', 'validadeTVL'],
  ['logradouro', 'logradouro'],
  ['numero', 'numero'],
  ['complemento', 'complemento'],
  ['bairro', 'bairro'],
  ['cep', 'cep'],
  ['telefone', 'telefone'],
  ['correio eletronico', 'email'],
  ['e-mail', 'email'],
  ['email', 'email'],
  ['cnae principal', 'cnaePrincipal'],
  ['data inicio', 'cnaeDataInicio'],
  ['observacoes', 'observacoes'],
];

let configPortal: PortalConfig | null = null;

async function obterConfigPortal(): Promise<PortalConfig> {
  if (configPortal === null) {
    configPortal = await carregarPortalConfig('ficha-cadastral');
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

export function analisarTextoFicha(texto: string): Record<string, string> {
  return analisarTextoComRotulos(texto, ROTULOS_FICHA);
}

function normalizarDados(cnpjBuscado: string, brutos: Record<string, string>): Record<string, string> {
  const obter = (chave: string): string => brutos[chave] ?? '';
  return {
    cnpjBuscado,
    razaoSocial: obter('razaoSocial'),
    nomeFantasia: obter('nomeFantasia'),
    cnpj: somenteDigitos(obter('cnpj')),
    inscricaoMunicipal: somenteDigitos(obter('inscricaoMunicipal')),
    situacaoCadastral: obter('situacaoCadastral'),
    dataInscricaoPrefeitura: obter('dataInscricaoPrefeitura'),
    tipoUnidade: obter('tipoUnidade'),
    formaAtuacao: obter('formaAtuacao'),
    tipoConstituicao: obter('tipoConstituicao'),
    naturezaJuridica: obter('naturezaJuridica'),
    numeroTVL: obter('numeroTVL'),
    validadeTVL: obter('validadeTVL'),
    logradouro: obter('logradouro'),
    numero: obter('numero'),
    complemento: obter('complemento'),
    bairro: obter('bairro'),
    cep: formatarCep(obter('cep')),
    telefone: obter('telefone'),
    email: obter('email'),
    cnaePrincipal: obter('cnaePrincipal'),
    cnaeDataInicio: obter('cnaeDataInicio'),
    observacoes: obter('observacoes'),
  };
}

export class FichaCadastralRobot extends BaseRobot {
  readonly tipo = 'ficha-cadastral';
  readonly nome = 'Ficha Cadastral Salvador';
  readonly portal = 'PREF_SALVADOR';

  private readonly extratorTexto?: ExtratorTextoPdf;

  constructor(extratorTexto?: ExtratorTextoPdf) {
    super();
    this.extratorTexto = extratorTexto;
  }

  async executar(params: Record<string, unknown>, ctx: ExecucaoCtx): Promise<ResultadoRobot> {
    const entrada = fichaCadastralInputSchema.safeParse(params);
    if (!entrada.success) {
      throw new ValidationError('CNPJ inválido: deve conter 14 dígitos', entrada.error.flatten());
    }
    const cnpj = entrada.data.cnpj;
    try {
      const config = await obterConfigPortal();
      const cadeias = extrairCadeias(config);
      const pagina = ctx.sessao.page;
      this.emitir(ctx, 'log', `Iniciando consulta Ficha Cadastral para o CNPJ ${cnpj}`);
      await this.navegar(pagina, ctx, config);
      await this.selecionarTipoCnpj(pagina, ctx, cadeias);
      await this.preencherCnpj(pagina, ctx, cadeias, cnpj);
      const saidaPdf = await this.submeterEObterPdf(pagina, ctx, cadeias);
      if ('erroPortal' in saidaPdf) {
        return {
          sucesso: false,
          dados: { cnpjBuscado: cnpj },
          mensagem: `Ficha cadastral não encontrada para o CNPJ informado: ${saidaPdf.erroPortal}`,
        };
      }
      const texto = await this.extrairTextoPdf(saidaPdf.caminhoPdf, ctx);
      const dados = normalizarDados(cnpj, analisarTextoFicha(texto));
      const cnpjEncontrado = somenteDigitos(dados['cnpj'] ?? '');
      if (cnpjEncontrado !== '' && cnpjEncontrado !== somenteDigitos(cnpj)) {
        return {
          sucesso: false,
          dados: { cnpjBuscado: cnpj, cnpjEncontrado },
          mensagem: mensagemDivergenciaCnpj(cnpjEncontrado, somenteDigitos(cnpj)),
        };
      }
      await this.gerarArtefatos(pagina, ctx, cnpj, saidaPdf.caminhoPdf);
      if (dados['inscricaoMunicipal'] === '') {
        return {
          sucesso: false,
          dados: { cnpjBuscado: cnpj },
          mensagem: 'Ficha cadastral não encontrada para o CNPJ informado.',
        };
      }
      this.emitir(
        ctx,
        'log',
        `Consulta concluída: CGA ${dados['inscricaoMunicipal']} | Situação ${dados['situacaoCadastral']}`,
      );
      return {
        sucesso: true,
        dados,
        mensagem: 'Consulta Ficha Cadastral realizada com sucesso.',
      };
    } catch (erro) {
      this.emitir(ctx, 'error', mensagemDeErro(erro));
      throw erro;
    }
  }

  private async navegar(pagina: Page, ctx: ExecucaoCtx, config: PortalConfig): Promise<void> {
    exigirTempo(ctx.signal, 'navegar-portal');
    this.emitir(ctx, 'log', 'Acessando o portal da Ficha Cadastral');
    try {
      await pagina.goto(config.navegacao.url, {
        waitUntil: config.navegacao.waitUntil,
        timeout: TIMEOUT_NAVEGACAO_MS,
      });
    } catch (erro) {
      throw normalizarErro('navegar-portal', erro);
    }
  }

  private async selecionarTipoCnpj(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
  ): Promise<void> {
    exigirTempo(ctx.signal, 'selecionar-tipo-cnpj');
    this.emitir(ctx, 'log', 'Selecionando a pesquisa por CNPJ');
    try {
      const opcao = await localizarPorChave(pagina, 'radio_cnpj', cadeias, 'selecionar-tipo-cnpj');
      await opcao.check();
    } catch (erro) {
      throw normalizarErro('selecionar-tipo-cnpj', erro);
    }
  }

  private async preencherCnpj(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
    cnpj: string,
  ): Promise<void> {
    exigirTempo(ctx.signal, 'preencher-cnpj');
    this.emitir(ctx, 'log', 'Preenchendo o CNPJ para consulta');
    try {
      const campo = await localizarPorChave(pagina, 'campo_cnpj', cadeias, 'preencher-cnpj');
      await campo.fill('');
      await campo.fill(cnpj);
    } catch (erro) {
      throw normalizarErro('preencher-cnpj', erro);
    }
  }

  private async submeterEObterPdf(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
  ): Promise<{ caminhoPdf: string } | { erroPortal: string }> {
    exigirTempo(ctx.signal, 'submeter-consulta');
    this.emitir(ctx, 'log', 'Submetendo a consulta e aguardando o PDF oficial');
    try {
      const botao = await localizarPorChave(pagina, 'botao_consultar', cadeias, 'submeter-consulta');
      const esperaDownload = pagina.waitForEvent('download', { timeout: TIMEOUT_DOWNLOAD_MS });
      await botao.click();
      exigirTempo(ctx.signal, 'aguardar-download');
      const [descarga, erro] = await Promise.all([
        esperaDownload.then(
          (download) => download,
          () => null,
        ),
        this.lerErroPortal(pagina, cadeias).catch(() => ''),
      ]);
      if (descarga !== null) {
        const diretorio = path.join(tmpdir(), 'api-sefaz-ssa', `ficha-cadastral-${Date.now()}`);
        await mkdir(diretorio, { recursive: true });
        const caminhoPdf = path.join(diretorio, 'ficha-cadastral.pdf');
        await descarga.saveAs(caminhoPdf);
        return { caminhoPdf };
      }
      if (erro !== '') {
        return { erroPortal: erro };
      }
      throw new EtapaError(
        'aguardar-download',
        'PDF oficial não baixado e nenhuma mensagem do portal foi encontrada.',
      );
    } catch (erro) {
      throw normalizarErro('aguardar-download', erro);
    }
  }

  private async lerErroPortal(
    pagina: Page,
    cadeias: Record<string, CadeiaSeletores>,
  ): Promise<string> {
    return lerErroPortalCompartilhado(pagina, cadeias, TIMEOUT_DOWNLOAD_MS);
  }

  private async extrairTextoPdf(caminhoPdf: string, ctx: ExecucaoCtx): Promise<string> {
    exigirTempo(ctx.signal, 'extrair-dados');
    this.emitir(ctx, 'log', 'Extraindo o texto do PDF oficial');
    const extrator = this.extratorTexto ?? obterExtratorTextoPdf();
    try {
      return await extrator(caminhoPdf);
    } catch (erro) {
      throw normalizarErro('extrair-dados', erro);
    }
  }

  private async gerarArtefatos(
    pagina: Page,
    ctx: ExecucaoCtx,
    cnpj: string,
    caminhoPdf: string,
  ): Promise<void> {
    try {
      exigirTempo(ctx.signal, 'gerar-artefatos');
      if (ctx.artefatos === 'nenhum') {
        return;
      }
      this.emitir(ctx, 'log', 'Gerando os artefatos da consulta');
      const diretorio = path.join(tmpdir(), 'api-sefaz-ssa', `ficha-cadastral-${cnpj}`);
      await mkdir(diretorio, { recursive: true });
      if (ctx.artefatos === 'print' || ctx.artefatos === 'ambos') {
        const print = await pagina.screenshot({ type: 'jpeg', quality: 70, fullPage: true });
        const caminhoPrint = path.join(diretorio, 'print.jpg');
        await writeFile(caminhoPrint, print);
        ctx.registrarArquivo('print', caminhoPrint, 'image/jpeg');
      }
      if (ctx.artefatos === 'pdf' || ctx.artefatos === 'ambos') {
        const caminhoOficial = path.join(diretorio, 'ficha-cadastral.pdf');
        await copyFile(caminhoPdf, caminhoOficial);
        ctx.registrarArquivo('pdf_oficial', caminhoOficial, 'application/pdf');
      }
    } catch (erro) {
      this.emitir(ctx, 'warn', `Falha ao gerar artefatos: ${mensagemDeErro(erro)} — seguindo sem artefatos.`);
    }
  }
}

function validarPayload(payload: string): { cnpj: string; artefatos: ArtefatosEscolha } {
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
  const entrada = fichaCadastralInputSchema.safeParse(registro);
  if (!entrada.success) {
    throw new ValidationError('CNPJ inválido: deve conter 14 dígitos', entrada.error.flatten());
  }
  const artefatos = artefatosEscolhaSchema.safeParse(registro['artefatos'] ?? 'nenhum');
  if (!artefatos.success) {
    throw new ValidationError('Opção de artefatos inválida: use nenhum, pdf, print ou ambos');
  }
  return { cnpj: entrada.data.cnpj, artefatos: artefatos.data };
}

export const executarFichaCadastral = async (
  execucao: Execucao,
  sessao: BrowserSession,
): Promise<ResultadoExecutor> => {
  const { cnpj, artefatos } = validarPayload(execucao.payload);
  const canal = obterCanalProgresso();
  const robo = new FichaCadastralRobot();
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
    signal: AbortSignal.timeout(FICHA_CADASTRAL_TIMEOUT_MS),
  };
  const resultado = await robo.executar({ cnpj }, ctx);
  const saida: Record<string, unknown> = { sucesso: resultado.sucesso, dados: resultado.dados };
  if (resultado.mensagem !== undefined) {
    saida['mensagem'] = resultado.mensagem;
  }
  for (const arquivo of arquivos) {
    const conteudo = await readFile(arquivo.caminho);
    if (arquivo.tipo === 'print') {
      saida['printBase64'] = conteudo.toString('base64');
    }
    if (arquivo.tipo === 'pdf_oficial' || arquivo.tipo === 'pdf_pagina') {
      saida['pdfBase64'] = conteudo.toString('base64');
    }
  }
  return saida;
};

registrarExecutor('ficha-cadastral', executarFichaCadastral);
