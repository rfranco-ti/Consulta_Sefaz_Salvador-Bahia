import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Download, Locator, Page } from 'playwright-core';
import { z } from 'zod';
import { BaseRobot, type ExecucaoCtx, type ResultadoRobot } from '../../base/base-robot.js';
import {
  analisarTextoComRotulos,
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

export const ALVARA_FUNCIONAMENTO_TIMEOUT_MS = 120000;

const TIMEOUT_NAVEGACAO_MS = 30000;
const TIMEOUT_DOWNLOAD_MS = 8000;
const TIMEOUT_CONFIRMAR_MS = 3000;

const baseAlvaraSchema = z.object({
  cnpj: z.string(),
  inscricaoMunicipal: z.string().optional(),
  cga: z.string().optional(),
  inscricao_municipal: z.string().optional(),
  cpf: z.string().optional(),
});

export const alvaraFuncionamentoInputSchema = z.object({
  cnpj: z
    .string()
    .transform((valor) => valor.replace(/\D/g, ''))
    .refine((valor) => valor.length === 14, 'CNPJ inválido: deve conter 14 dígitos'),
  inscricaoMunicipal: z
    .string()
    .transform((valor) => valor.replace(/\D/g, ''))
    .refine(
      (valor) => valor.length >= 6 && valor.length <= 15,
      'Inscrição municipal (CGA) inválida: informe de 6 a 15 dígitos',
    ),
  cpf: z
    .string()
    .transform((valor) => valor.replace(/\D/g, ''))
    .refine((valor) => valor.length === 11, 'CPF inválido: deve conter 11 dígitos')
    .optional(),
});

export interface AlvaraFuncionamentoParams {
  cnpj: string;
  inscricaoMunicipal: string;
  cpf: string | null;
}

const artefatosEscolhaSchema = z.enum(['nenhum', 'pdf', 'print', 'ambos']);

type ArtefatosEscolha = z.infer<typeof artefatosEscolhaSchema>;

type ArquivoRegistrado = {
  tipo: Parameters<ExecucaoCtx['registrarArquivo']>[0];
  caminho: string;
  contentType: Parameters<ExecucaoCtx['registrarArquivo']>[2];
};

const ROTULOS_ALVARA: Array<readonly [string, string]> = [
  ['razao social', 'razaoSocial'],
  ['nome fantasia', 'nomeFantasia'],
  ['cnpj', 'cnpj'],
  ['inscricao municipal (cga)', 'inscricaoMunicipal'],
  ['inscricao municipal', 'inscricaoMunicipal'],
  ['cga', 'inscricaoMunicipal'],
  ['tipo de constituicao', 'constituicaoEmpresa'],
  ['constituicao da empresa', 'constituicaoEmpresa'],
  ['natureza juridica', 'naturezaJuridica'],
  ['tipo de unidade', 'tipoUnidade'],
  ['forma de atuacao', 'formaAtuacao'],
  ['situacao cadastral', 'situacaoCadastral'],
  ['data de inscricao', 'dataInscricao'],
  ['data inscricao', 'dataInscricao'],
  ['data de impressao', 'dataImpressao'],
  ['data impressao', 'dataImpressao'],
  ['validade do alvara', 'validadeAlvara'],
  ['validade alvara', 'validadeAlvara'],
  ['no do tvl', 'numeroTVL'],
  ['n do tvl', 'numeroTVL'],
  ['numero do tvl', 'numeroTVL'],
  ['validade do tvl', 'validadeTVL'],
  ['validade tvl', 'validadeTVL'],
  ['codigo de controle', 'codigoControle'],
  ['codigo controle', 'codigoControle'],
  ['logradouro', 'logradouro'],
  ['complemento', 'complemento'],
  ['bairro', 'bairro'],
  ['cnae principal', 'cnaeCodigo'],
  ['codigo cnae', 'cnaeCodigo'],
  ['descricao cnae', 'cnaeDescricao'],
  ['descricao da atividade', 'cnaeDescricao'],
  ['data de inicio', 'cnaeDataInicio'],
  ['data inicio', 'cnaeDataInicio'],
  ['observacoes', 'observacoes'],
  ['observacao', 'observacoes'],
];

let configPortal: PortalConfig | null = null;

async function obterConfigPortal(): Promise<PortalConfig> {
  if (configPortal === null) {
    configPortal = await carregarPortalConfig('alvara-funcionamento');
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

function validarEntrada(params: Record<string, unknown>): AlvaraFuncionamentoParams {
  const base = baseAlvaraSchema.safeParse(params);
  if (!base.success) {
    throw new ValidationError('Parâmetros inválidos para a consulta do alvará', base.error.flatten());
  }
  const cgaBruta = base.data.inscricaoMunicipal ?? base.data.cga ?? base.data.inscricao_municipal ?? '';
  const cpfBruto = (base.data.cpf ?? '').trim();
  const entrada = alvaraFuncionamentoInputSchema.safeParse({
    cnpj: base.data.cnpj,
    inscricaoMunicipal: cgaBruta,
    ...(cpfBruto === '' ? {} : { cpf: cpfBruto }),
  });
  if (!entrada.success) {
    const campos = entrada.error.flatten().fieldErrors;
    if (campos['cnpj'] !== undefined) {
      throw new ValidationError('CNPJ inválido: deve conter 14 dígitos', entrada.error.flatten());
    }
    if (campos['inscricaoMunicipal'] !== undefined) {
      throw new ValidationError(
        'Inscrição municipal (CGA) inválida: informe de 6 a 15 dígitos',
        entrada.error.flatten(),
      );
    }
    throw new ValidationError('CPF inválido: deve conter 11 dígitos', entrada.error.flatten());
  }
  return {
    cnpj: entrada.data.cnpj,
    inscricaoMunicipal: entrada.data.inscricaoMunicipal,
    cpf: entrada.data.cpf ?? null,
  };
}

export function analisarTextoAlvara(texto: string): Record<string, string> {
  return analisarTextoComRotulos(texto, ROTULOS_ALVARA);
}

function normalizarDados(
  cnpjBuscado: string,
  cgaBuscada: string,
  brutos: Record<string, string>,
): Record<string, string> {
  const obter = (chave: string): string => brutos[chave] ?? '';
  return {
    cnpjBuscado,
    inscricaoMunicipalBuscada: cgaBuscada,
    razaoSocial: obter('razaoSocial'),
    nomeFantasia: obter('nomeFantasia'),
    cnpj: somenteDigitos(obter('cnpj')),
    inscricaoMunicipal: somenteDigitos(obter('inscricaoMunicipal')),
    constituicaoEmpresa: obter('constituicaoEmpresa'),
    naturezaJuridica: obter('naturezaJuridica'),
    tipoUnidade: obter('tipoUnidade'),
    formaAtuacao: obter('formaAtuacao'),
    situacaoCadastral: obter('situacaoCadastral'),
    dataInscricao: obter('dataInscricao'),
    dataImpressao: obter('dataImpressao'),
    validadeAlvara: obter('validadeAlvara'),
    numeroTVL: obter('numeroTVL'),
    validadeTVL: obter('validadeTVL'),
    codigoControle: obter('codigoControle'),
    logradouro: obter('logradouro'),
    complemento: obter('complemento'),
    bairro: obter('bairro'),
    cnaeCodigo: obter('cnaeCodigo'),
    cnaeDescricao: obter('cnaeDescricao'),
    cnaeDataInicio: obter('cnaeDataInicio'),
    observacoes: obter('observacoes'),
  };
}

export class AlvaraFuncionamentoRobot extends BaseRobot {
  readonly tipo = 'alvara-funcionamento';
  readonly nome = 'Alvará de Funcionamento Salvador';
  readonly portal = 'PREF_SALVADOR';

  private readonly extratorTexto?: ExtratorTextoPdf;

  constructor(extratorTexto?: ExtratorTextoPdf) {
    super();
    this.extratorTexto = extratorTexto;
  }

  async executar(params: Record<string, unknown>, ctx: ExecucaoCtx): Promise<ResultadoRobot> {
    const entrada = validarEntrada(params);
    try {
      const config = await obterConfigPortal();
      const cadeias = extrairCadeias(config);
      const pagina = ctx.sessao.page;
      this.emitir(
        ctx,
        'log',
        `Iniciando consulta Alvará para o CNPJ ${entrada.cnpj} e a CGA ${entrada.inscricaoMunicipal}`,
      );
      await this.navegar(pagina, ctx, config);
      await this.preencherCnpj(pagina, ctx, cadeias, entrada.cnpj);
      await this.preencherCga(pagina, ctx, cadeias, entrada.inscricaoMunicipal);
      await this.preencherCpf(pagina, ctx, cadeias, entrada.cpf);
      const saidaPdf = await this.submeterEObterPdf(
        pagina,
        ctx,
        cadeias,
        entrada.cnpj,
        entrada.inscricaoMunicipal,
      );
      if ('erroPortal' in saidaPdf) {
        return {
          sucesso: false,
          dados: {
            cnpjBuscado: entrada.cnpj,
            inscricaoMunicipalBuscada: entrada.inscricaoMunicipal,
          },
          mensagem: `Alvará não encontrado para o CNPJ e a inscrição municipal informados: ${saidaPdf.erroPortal}`,
        };
      }
      const texto = await this.extrairTextoPdf(saidaPdf.caminhoPdf, ctx);
      const dados = normalizarDados(entrada.cnpj, entrada.inscricaoMunicipal, analisarTextoAlvara(texto));
      const cnpjEncontrado = somenteDigitos(dados['cnpj'] ?? '');
      if (cnpjEncontrado !== '' && cnpjEncontrado !== somenteDigitos(entrada.cnpj)) {
        return {
          sucesso: false,
          dados: {
            cnpjBuscado: entrada.cnpj,
            inscricaoMunicipalBuscada: entrada.inscricaoMunicipal,
            cnpjEncontrado,
          },
          mensagem: mensagemDivergenciaCnpj(cnpjEncontrado, somenteDigitos(entrada.cnpj)),
        };
      }
      await this.gerarArtefatos(pagina, ctx, entrada.cnpj, entrada.inscricaoMunicipal, saidaPdf.caminhoPdf);
      if (dados['razaoSocial'] === '') {
        return {
          sucesso: false,
          dados: {
            cnpjBuscado: entrada.cnpj,
            inscricaoMunicipalBuscada: entrada.inscricaoMunicipal,
          },
          mensagem: 'Alvará não encontrado para o CNPJ e a inscrição municipal informados.',
        };
      }
      this.emitir(
        ctx,
        'log',
        `Consulta concluída: ${dados['razaoSocial'] ?? ''} | Situação ${dados['situacaoCadastral'] ?? ''}`,
      );
      return {
        sucesso: true,
        dados,
        mensagem: 'Consulta Alvará de Funcionamento realizada com sucesso.',
      };
    } catch (erro) {
      this.emitir(ctx, 'error', mensagemDeErro(erro));
      throw erro;
    }
  }

  private async navegar(pagina: Page, ctx: ExecucaoCtx, config: PortalConfig): Promise<void> {
    exigirTempo(ctx.signal, 'navegar-portal');
    this.emitir(ctx, 'log', 'Acessando o portal do Alvará de Funcionamento');
    try {
      await pagina.goto(config.navegacao.url, {
        waitUntil: config.navegacao.waitUntil,
        timeout: TIMEOUT_NAVEGACAO_MS,
      });
    } catch (erro) {
      throw normalizarErro('navegar-portal', erro);
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

  private async preencherCga(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
    inscricaoMunicipal: string,
  ): Promise<void> {
    exigirTempo(ctx.signal, 'preencher-cga');
    this.emitir(ctx, 'log', 'Preenchendo a inscrição municipal (CGA) para consulta');
    try {
      const campo = await localizarPorChave(pagina, 'campo_cga', cadeias, 'preencher-cga');
      await campo.fill('');
      await campo.fill(inscricaoMunicipal);
    } catch (erro) {
      throw normalizarErro('preencher-cga', erro);
    }
  }

  private async preencherCpf(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
    cpf: string | null,
  ): Promise<void> {
    if (cpf === null) {
      return;
    }
    exigirTempo(ctx.signal, 'preencher-cpf');
    this.emitir(ctx, 'log', 'Preenchendo o CPF do representante para consulta');
    try {
      const campo = await localizarPorChave(pagina, 'campo_cpf', cadeias, 'preencher-cpf');
      await campo.fill('');
      await campo.fill(cpf);
    } catch (erro) {
      throw normalizarErro('preencher-cpf', erro);
    }
  }

  private async submeterEObterPdf(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
    cnpj: string,
    inscricaoMunicipal: string,
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
        return { caminhoPdf: await this.salvarDownload(descarga, cnpj, inscricaoMunicipal) };
      }
      if (await this.confirmarEmissao(pagina, ctx, cadeias)) {
        const segunda = await pagina
          .waitForEvent('download', { timeout: TIMEOUT_DOWNLOAD_MS })
          .then(
            (download) => download,
            () => null,
          );
        if (segunda !== null) {
          return { caminhoPdf: await this.salvarDownload(segunda, cnpj, inscricaoMunicipal) };
        }
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

  private async salvarDownload(
    descarga: Download,
    cnpj: string,
    inscricaoMunicipal: string,
  ): Promise<string> {
    const diretorio = path.join(
      tmpdir(),
      'api-sefaz-ssa',
      `alvara-funcionamento-${cnpj}-${inscricaoMunicipal}-${Date.now()}`,
    );
    await mkdir(diretorio, { recursive: true });
    const caminhoPdf = path.join(diretorio, 'alvara.pdf');
    await descarga.saveAs(caminhoPdf);
    return caminhoPdf;
  }

  private async confirmarEmissao(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
  ): Promise<boolean> {
    exigirTempo(ctx.signal, 'aguardar-download');
    let botao: Locator | null = null;
    try {
      botao = await localizarPorChave(
        pagina,
        'botao_confirmar',
        cadeias,
        'aguardar-download',
        TIMEOUT_CONFIRMAR_MS,
      );
    } catch {
      return false;
    }
    this.emitir(ctx, 'log', 'Confirmando a emissão do novo alvará');
    await botao.click();
    return true;
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
    inscricaoMunicipal: string,
    caminhoPdf: string,
  ): Promise<void> {
    try {
      exigirTempo(ctx.signal, 'gerar-artefatos');
      if (ctx.artefatos === 'nenhum') {
        return;
      }
      this.emitir(ctx, 'log', 'Gerando os artefatos da consulta');
      const diretorio = path.join(tmpdir(), 'api-sefaz-ssa', `alvara-funcionamento-${cnpj}-${inscricaoMunicipal}`);
      await mkdir(diretorio, { recursive: true });
      if (ctx.artefatos === 'print' || ctx.artefatos === 'ambos') {
        const print = await pagina.screenshot({ type: 'jpeg', quality: 70, fullPage: true });
        const caminhoPrint = path.join(diretorio, 'print.jpg');
        await writeFile(caminhoPrint, print);
        ctx.registrarArquivo('print', caminhoPrint, 'image/jpeg');
      }
      if (ctx.artefatos === 'pdf' || ctx.artefatos === 'ambos') {
        const caminhoOficial = path.join(diretorio, 'alvara.pdf');
        await copyFile(caminhoPdf, caminhoOficial);
        ctx.registrarArquivo('pdf_oficial', caminhoOficial, 'application/pdf');
      }
    } catch (erro) {
      this.emitir(ctx, 'warn', `Falha ao gerar artefatos: ${mensagemDeErro(erro)} — seguindo sem artefatos.`);
    }
  }
}

function validarPayload(payload: string): { entrada: AlvaraFuncionamentoParams; artefatos: ArtefatosEscolha } {
  let bruto: unknown;
  try {
    bruto = JSON.parse(payload) as unknown;
  } catch {
    throw new ValidationError('Payload da execução inválido: JSON malformado');
  }
  if (typeof bruto !== 'object' || bruto === null) {
    throw new ValidationError('Payload da execução inválido: objeto esperado');
  }
  const entrada = validarEntrada(bruto as Record<string, unknown>);
  const artefatos = artefatosEscolhaSchema.safeParse(
    (bruto as Record<string, unknown>)['artefatos'] ?? 'nenhum',
  );
  if (!artefatos.success) {
    throw new ValidationError('Opção de artefatos inválida: use nenhum, pdf, print ou ambos');
  }
  return { entrada, artefatos: artefatos.data };
}

export const executarAlvaraFuncionamento = async (
  execucao: Execucao,
  sessao: BrowserSession,
): Promise<ResultadoExecutor> => {
  const { entrada, artefatos } = validarPayload(execucao.payload);
  const canal = obterCanalProgresso();
  const robo = new AlvaraFuncionamentoRobot();
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
    signal: AbortSignal.timeout(ALVARA_FUNCIONAMENTO_TIMEOUT_MS),
  };
  const resultado = await robo.executar(
    {
      cnpj: entrada.cnpj,
      inscricaoMunicipal: entrada.inscricaoMunicipal,
      ...(entrada.cpf === null ? {} : { cpf: entrada.cpf }),
    },
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
    if (arquivo.tipo === 'pdf_oficial' || arquivo.tipo === 'pdf_pagina') {
      saida['pdfBase64'] = conteudo.toString('base64');
    }
  }
  return saida;
};

registrarExecutor('alvara-funcionamento', executarAlvaraFuncionamento);
