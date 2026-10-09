import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import {
  BaseRobot,
  diretorioArtefatosExecucao,
  removerDiretoriosTemporariosDaExecucao,
  type ExecucaoCtx,
  type ResultadoRobot,
} from '../../base/base-robot.js';
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

export const IPTU_SALVADOR_TIMEOUT_MS = 90000;

const TIMEOUT_NAVEGACAO_MS = 30000;
const TIMEOUT_RESULTADO_POR_TENTATIVA_MS = 8000;
const TIMEOUT_POPUP_MS = 20000;
const TEMPO_ASSENTAMENTO_POS_PREENCHIMENTO_MS = 1500;

export const iptuSalvadorInputSchema = z.object({
  numeroIptu: z
    .string()
    .transform((valor) => valor.replace(/\D/g, ''))
    .refine(
      (valor) => valor.length >= 5 && valor.length <= 10,
      'Número do IPTU inválido: deve conter de 5 a 10 dígitos',
    ),
});

export type IptuSalvadorParams = z.infer<typeof iptuSalvadorInputSchema>;

const artefatosEscolhaSchema = z.enum(['nenhum', 'pdf', 'print', 'ambos']);

type ArtefatosEscolha = z.infer<typeof artefatosEscolhaSchema>;

interface ElementoCertidao {
  readonly textContent: string | null;
}

interface DocumentoCertidao {
  getElementById(id: string): ElementoCertidao | null;
  readonly body: { readonly innerText: string } | null;
}

declare const document: DocumentoCertidao;

type ArquivoRegistrado = {
  tipo: Parameters<ExecucaoCtx['registrarArquivo']>[0];
  caminho: string;
  contentType: Parameters<ExecucaoCtx['registrarArquivo']>[2];
};

let configPortal: PortalConfig | null = null;

async function obterConfigPortal(): Promise<PortalConfig> {
  if (configPortal === null) {
    configPortal = await carregarPortalConfig('iptu-salvador');
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

function extrairCertidao(): Record<string, string> {
  const prefixo = 'ctl00_ContentPlaceHolderPrincipal_UCCertidaoDadosCadastrais_';
  const aplainar = (texto: string): string =>
    texto.replace(/\u00a0/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const obter = (sufixo: string): string => {
    const elemento = document.getElementById(`${prefixo}${sufixo}`);
    return aplainar(elemento?.textContent ?? '');
  };
  return {
    titulo: obter('LbdsTitulo'),
    inscricao: obter('LbCdInscricaoImob'),
    cib: obter('LbNuCIB'),
    inscricaoMae: obter('Lcdinscricaomae'),
    contribuinte: obter('LbnmContribuinte'),
    cpfCnpj: obter('LbnuCnpjCpf'),
    endereco: obter('LbdsLogradouro'),
    numeroMetrico: obter('LbnuMetrico'),
    numeroPorta: obter('LbnuPorta'),
    loteamento: obter('LbdsLoteamento'),
    quadra: obter('LbdsQuadra'),
    lote: obter('LbdsLote'),
    conjunto: obter('LbdsConjuntoHabitacional'),
    edificio: obter('LbdsEdificio'),
    bloco: obter('LbnuBloco'),
    subUnidadeCod: obter('LbcdSubUnidade'),
    subUnidadeNome: obter('LbdsSubunidade'),
    numSubUnidade: obter('LbnuSubUnidade'),
    bairro: obter('LbdsBairro'),
    cep: obter('LbnuCEP'),
    complemento: obter('LbdsComplementoEndereco'),
    areaTerreno: obter('LbvlAreaTerreno'),
    fracaoIdeal: obter('LbvlFracaoIdeal'),
    areaConstruida: obter('LbvlAreaConstruida'),
    areaTotal: obter('LbvlAreaTotal'),
    valorVenal: obter('LbvlVenalIPTU'),
    tipoImovel: obter('LbdsUtilizacao'),
    padraoConstrutivo: obter('LbdsPadraoConstrutivo'),
    logradouroTrib: obter('LbdsLogradouroTrib'),
    dataLancamento: obter('LbDtVigenciaLanc'),
    situacaoCadastral: obter('LbdsSituacaoCadastral'),
    situacaoFiscal: obter('LbdsSituacaoFiscalIPTU'),
    dataEmissao: obter('LbdtEmissao'),
    textoCertidao: obter('LbTextoCertidao'),
    codigoControle: obter('LbCodigoControleCertidao'),
    textoValidade: obter('LbTextoValidade'),
    textoRodape: obter('LbTextoRodape'),
    textoBruto: document.body?.innerText ?? '',
  };
}

function normalizarDados(numeroBuscado: string, brutos: Record<string, string>): Record<string, string> {
  const obter = (chave: string): string => brutos[chave] ?? '';
  const formatarCep = (valor: string): string => {
    const digitos = valor.replace(/\D/g, '');
    return digitos.length === 8 ? `${digitos.slice(0, 5)}-${digitos.slice(5)}` : valor;
  };
  return {
    numeroIptuBuscado: numeroBuscado,
    titulo: obter('titulo'),
    inscricao: obter('inscricao'),
    cib: obter('cib'),
    inscricaoMae: obter('inscricaoMae'),
    contribuinte: obter('contribuinte'),
    cpfCnpj: obter('cpfCnpj'),
    endereco: obter('endereco'),
    numeroMetrico: obter('numeroMetrico'),
    numeroPorta: obter('numeroPorta'),
    loteamento: obter('loteamento'),
    quadra: obter('quadra'),
    lote: obter('lote'),
    conjunto: obter('conjunto'),
    edificio: obter('edificio'),
    bloco: obter('bloco'),
    subUnidadeCod: obter('subUnidadeCod'),
    subUnidadeNome: obter('subUnidadeNome'),
    numSubUnidade: obter('numSubUnidade'),
    bairro: obter('bairro'),
    cep: formatarCep(obter('cep')),
    complemento: obter('complemento'),
    areaTerreno: obter('areaTerreno'),
    fracaoIdeal: obter('fracaoIdeal'),
    areaConstruida: obter('areaConstruida'),
    areaTotal: obter('areaTotal'),
    valorVenal: obter('valorVenal'),
    tipoImovel: obter('tipoImovel'),
    padraoConstrutivo: obter('padraoConstrutivo'),
    logradouroTrib: obter('logradouroTrib'),
    dataLancamento: obter('dataLancamento'),
    situacaoCadastral: obter('situacaoCadastral'),
    situacaoFiscal: obter('situacaoFiscal'),
    dataEmissao: obter('dataEmissao'),
    textoCertidao: obter('textoCertidao'),
    codigoControle: obter('codigoControle'),
    textoValidade: obter('textoValidade'),
    textoRodape: obter('textoRodape'),
  };
}

export function nomePdfIptuSalvador(numeroIptu: string): string {
  return `DADOS-CADASTRAIS-IPTU_${numeroIptu}.PDF`;
}

export class IptuSalvadorRobot extends BaseRobot {
  readonly tipo = 'iptu-salvador';
  readonly nome = 'IPTU Salvador';
  readonly portal = 'PREF_SALVADOR';

  async executar(params: Record<string, unknown>, ctx: ExecucaoCtx): Promise<ResultadoRobot> {
    const entrada = iptuSalvadorInputSchema.safeParse(params);
    if (!entrada.success) {
      throw new ValidationError(
        'Número do IPTU inválido: deve conter de 5 a 10 dígitos',
        entrada.error.flatten(),
      );
    }
    const numeroIptu = entrada.data.numeroIptu;
    try {
      const config = await obterConfigPortal();
      const cadeias = extrairCadeias(config);
      const pagina = ctx.sessao.page;
      this.emitir(ctx, 'log', `Iniciando consulta IPTU Salvador para a inscrição ${numeroIptu}`);
      await this.navegar(pagina, ctx, config);
      await this.preencherInscricao(pagina, ctx, cadeias, numeroIptu);
      const popup = await this.submeterConsulta(pagina, ctx, cadeias);
      if (popup === null) {
        return {
          sucesso: false,
          dados: { numeroIptuBuscado: numeroIptu },
          mensagem:
            'Inscrição imobiliária não encontrada ou sem certidão de dados cadastrais para o número informado.',
        };
      }
      const brutos = await this.extrairDados(popup, ctx);
      const dados = normalizarDados(numeroIptu, brutos);
      await this.gerarArtefatos(popup, ctx, numeroIptu);
      if (dados['inscricao'] === '') {
        return {
          sucesso: false,
          dados: { numeroIptuBuscado: numeroIptu },
          mensagem: 'Inscrição imobiliária não encontrada ou sem certidão de dados cadastrais para o número informado.',
        };
      }
      this.emitir(
        ctx,
        'log',
        `Consulta concluída: inscrição ${dados['inscricao']} | Contribuinte ${dados['contribuinte']}`,
      );
      return {
        sucesso: true,
        dados,
        mensagem: 'Consulta IPTU Salvador realizada com sucesso.',
      };
    } catch (erro) {
      this.emitir(ctx, 'error', mensagemDeErro(erro));
      throw erro;
    }
  }

  private async navegar(pagina: Page, ctx: ExecucaoCtx, config: PortalConfig): Promise<void> {
    exigirTempo(ctx.signal, 'navegar-portal');
    this.emitir(ctx, 'log', 'Acessando o portal da SEFAZ Salvador');
    try {
      await pagina.goto(config.navegacao.url, {
        waitUntil: config.navegacao.waitUntil,
        timeout: TIMEOUT_NAVEGACAO_MS,
      });
    } catch (erro) {
      throw normalizarErro('navegar-portal', erro);
    }
  }

  private async preencherInscricao(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
    numeroIptu: string,
  ): Promise<void> {
    exigirTempo(ctx.signal, 'preencher-inscricao');
    this.emitir(ctx, 'log', 'Preenchendo a inscrição imobiliária para consulta');
    try {
      const campo = await localizarPorChave(pagina, 'campo_inscricao', cadeias, 'preencher-inscricao');
      await campo.fill('');
      await campo.fill(numeroIptu);
      await campo.press('Tab').catch(() => undefined);
      await pagina.waitForTimeout(TEMPO_ASSENTAMENTO_POS_PREENCHIMENTO_MS);
    } catch (erro) {
      throw normalizarErro('preencher-inscricao', erro);
    }
  }

  private async submeterConsulta(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
  ): Promise<Page | null> {
    exigirTempo(ctx.signal, 'submeter-consulta');
    this.emitir(ctx, 'log', 'Submetendo a consulta e aguardando a certidão em nova janela');
    try {
      const botao = await localizarPorChave(pagina, 'botao_consultar', cadeias, 'submeter-consulta');
      const esperaPopup = pagina.context().waitForEvent('page', { timeout: TIMEOUT_POPUP_MS });
      await botao.click();
      exigirTempo(ctx.signal, 'aguardar-resultado');
      const popup = await esperaPopup.then(
        (nova) => nova,
        () => null,
      );
      if (popup === null) {
        return null;
      }
      await popup.waitForLoadState('domcontentloaded', { timeout: TIMEOUT_NAVEGACAO_MS }).catch(() => undefined);
      await localizarPorChave(
        popup,
        'bloco_resultado',
        cadeias,
        'aguardar-resultado',
        TIMEOUT_RESULTADO_POR_TENTATIVA_MS,
      );
      return popup;
    } catch (erro) {
      throw normalizarErro('aguardar-resultado', erro);
    }
  }

  private async extrairDados(pagina: Page, ctx: ExecucaoCtx): Promise<Record<string, string>> {
    exigirTempo(ctx.signal, 'extrair-dados');
    this.emitir(ctx, 'log', 'Extraindo os dados da certidão');
    try {
      return await pagina.evaluate(extrairCertidao);
    } catch (erro) {
      throw normalizarErro('extrair-dados', erro);
    }
  }

  private async gerarArtefatos(pagina: Page, ctx: ExecucaoCtx, numeroIptu: string): Promise<void> {
    exigirTempo(ctx.signal, 'gerar-artefatos');
    if (ctx.artefatos === 'nenhum') {
      return;
    }
    this.emitir(ctx, 'log', 'Gerando os artefatos da consulta');
    try {
      const diretorio = diretorioArtefatosExecucao('iptu-salvador', ctx.execucaoId, numeroIptu);
      await mkdir(diretorio, { recursive: true });
      if (ctx.artefatos === 'print' || ctx.artefatos === 'ambos') {
        const print = await pagina.screenshot({ type: 'jpeg', quality: 70, fullPage: true });
        const caminhoPrint = path.join(diretorio, 'print.jpg');
        await writeFile(caminhoPrint, print);
        ctx.registrarArquivo('print', caminhoPrint, 'image/jpeg');
      }
      if (ctx.artefatos === 'pdf' || ctx.artefatos === 'ambos') {
        const pdf = await pagina.pdf({ format: 'A4', printBackground: true });
        const caminhoPdf = path.join(diretorio, nomePdfIptuSalvador(numeroIptu));
        await writeFile(caminhoPdf, pdf);
        ctx.registrarArquivo('pdf_pagina', caminhoPdf, 'application/pdf');
      }
    } catch (erro) {
      this.emitir(ctx, 'warn', `Falha ao gerar artefatos: ${mensagemDeErro(erro)} — seguindo sem artefatos.`);
    }
  }
}

function validarPayload(payload: string): { numeroIptu: string; artefatos: ArtefatosEscolha } {
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
  const entrada = iptuSalvadorInputSchema.safeParse(registro);
  if (!entrada.success) {
    throw new ValidationError(
      'Número do IPTU inválido: deve conter de 5 a 10 dígitos',
      entrada.error.flatten(),
    );
  }
  const artefatos = artefatosEscolhaSchema.safeParse(registro['artefatos'] ?? 'nenhum');
  if (!artefatos.success) {
    throw new ValidationError('Opção de artefatos inválida: use nenhum, pdf, print ou ambos');
  }
  return { numeroIptu: entrada.data.numeroIptu, artefatos: artefatos.data };
}

export const executarIptuSalvador = async (
  execucao: Execucao,
  sessao: BrowserSession,
): Promise<ResultadoExecutor> => {
  const { numeroIptu, artefatos } = validarPayload(execucao.payload);
  const canal = obterCanalProgresso();
  const robo = new IptuSalvadorRobot();
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
    signal: AbortSignal.timeout(IPTU_SALVADOR_TIMEOUT_MS),
    execucaoId: execucao.id,
  };
  try {
    const resultado = await robo.executar({ numeroIptu }, ctx);
    const saida: Record<string, unknown> = { sucesso: resultado.sucesso, dados: resultado.dados };
    if (resultado.mensagem !== undefined) {
      saida['mensagem'] = resultado.mensagem;
    }
    for (const arquivo of arquivos) {
      const conteudo = await readFile(arquivo.caminho);
      if (arquivo.tipo === 'print') {
        saida['printBase64'] = conteudo.toString('base64');
      }
      if (arquivo.tipo === 'pdf_pagina') {
        saida['pdfBase64'] = conteudo.toString('base64');
      }
    }
    return saida;
  } finally {
    await removerDiretoriosTemporariosDaExecucao(execucao.id, ['iptu-salvador']).catch(
      () => undefined,
    );
  }
};

registrarExecutor('iptu-salvador', executarIptuSalvador);
