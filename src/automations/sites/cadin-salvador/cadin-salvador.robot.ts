import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page, Request as RequisicaoPlaywright } from 'playwright-core';
import { z } from 'zod';
import { BaseRobot, type ExecucaoCtx, type ResultadoRobot } from '../../base/base-robot.js';
import { resolverCaptcha as decodificarCaptcha } from '../../base/captcha.js';
import { detectarCaptchaImagem } from '../../base/captcha/detector.js';
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

export const CADIN_SALVADOR_TIMEOUT_MS = 180000;

const TIMEOUT_NAVEGACAO_MS = 30000;
const TIMEOUT_RESULTADO_POR_TENTATIVA_MS = 8000;
const TIMEOUT_IMAGEM_CAPTCHA_MS = 10000;
const INTERVALO_IMAGEM_CAPTCHA_MS = 250;
const TIMEOUT_QUIESCENCIA_REDE_MS = 8000;
const TIMEOUT_TROCA_CAPTCHA_MS = 5000;
const INTERVALO_SONDAGEM_RESULTADO_MS = 500;
const MAX_TENTATIVAS_CAPTCHA = 12;
const MAX_REFRESCOS_CAPTCHA = 8;
const TAMANHO_CODIGO_CAPTCHA = 5;
const INTERVALO_ESTABILIDADE_CAPTCHA_MS = 500;
const LEITURAS_ESTABILIDADE_CAPTCHA = 3;
const IDADE_MINIMA_PAGINA_MS = 8000;
const DIRETORIO_DIAG = path.join(process.cwd(), 'data', 'diag');
const ARQUIVO_DIAG_TENTATIVAS = 'cadin-diag-tentativas.jsonl';

interface LeituraCaptcha {
  codigo: string;
  caminhoImagem: string;
  guid: string | null;
}

interface RegistroDiagTentativa {
  evento: 'envio' | 'descarte';
  tentativa: number;
  documento: string;
  motivoDescarte: string;
  guidLido: string | null;
  codigoOcr: string;
  codigoEnviado: string;
  valorNoCampo: string;
  guidPreClick: string | null;
  docValorPre: string;
  docHabilitadoPre: boolean;
  guidNoSubmit: string | null;
  guidPosSubmit: string | null;
  erroPortal: string;
  imagemLida: string;
  imagemPreSubmit: string;
  imagemPosSubmit: string;
  hashLida: string;
  hashPreSubmit: string;
  hashPosSubmit: string;
  preIgualLida: boolean;
  idadePaginaMs: number;
  ocrPreSubmit: string;
  ocrPosSubmit: string;
  requisicoes: Array<{ ms: number; metodo: string; url: string }>;
}

interface RequisicaoDiag {
  ms: number;
  metodo: string;
  url: string;
  postado: string;
}

function extrairCaptchaPostado(requisicao: RequisicaoPlaywright): string {
  let corpo: string | null = null;
  try {
    corpo = requisicao.postData();
  } catch {
    return '';
  }
  if (corpo === null || corpo === '') {
    return '';
  }
  const encontrado = /CaptchaControl1=([^&]*)/.exec(corpo);
  if (encontrado?.[1] === undefined) {
    return '';
  }
  try {
    return decodeURIComponent(encontrado[1].replace(/\+/g, ' '));
  } catch {
    return encontrado[1];
  }
}

function diagAtivo(): boolean {
  return process.env['CADIN_DIAG'] === '1';
}

function somenteGuid(fonte: string | null): string | null {
  if (fonte === null) {
    return null;
  }
  const encontrado = /guid=([A-Za-z0-9-]+)/.exec(fonte);
  return encontrado?.[1] ?? fonte;
}

function resumirHash(conteudo: Buffer): string {
  return createHash('sha256').update(conteudo).digest('hex').slice(0, 12);
}

async function lerHashArquivo(caminho: string): Promise<string> {
  if (caminho === '') {
    return '';
  }
  const conteudo: Buffer | undefined = await readFile(caminho).catch(() => undefined);
  if (conteudo === undefined) {
    return '';
  }
  return resumirHash(conteudo);
}

async function arquivosIguais(primeiro: string, segundo: string): Promise<boolean> {
  const [conteudoPrimeiro, conteudoSegundo] = await Promise.all([
    readFile(primeiro).catch(() => undefined),
    readFile(segundo).catch(() => undefined),
  ]);
  if (conteudoPrimeiro === undefined || conteudoSegundo === undefined) {
    return false;
  }
  return conteudoPrimeiro.equals(conteudoSegundo);
}

function ehErroCaptchaVazio(erro: unknown): boolean {
  return (
    erro instanceof EtapaError &&
    erro.etapa === 'resolver-captcha' &&
    erro.message.includes('texto vazio')
  );
}

const MENSAGEM_DOCUMENTO_INVALIDO = 'Documento inválido: informe CPF com 11 dígitos ou CNPJ com 14 dígitos';

function somenteDigitos(valor: unknown): string {
  return typeof valor === 'string' ? valor.replace(/\D/g, '') : '';
}

const documentoBrutoSchema = z.object({
  documento: z.string().optional(),
  cpf: z.string().optional(),
  cnpj: z.string().optional(),
});

export const cadinSalvadorInputSchema = documentoBrutoSchema
  .transform((valor) => {
    const digitos = somenteDigitos(valor.documento ?? valor.cpf ?? valor.cnpj ?? '');
    return {
      documento: digitos,
      tipoDocumento: (digitos.length === 11 ? 'PF' : 'PJ') as 'PF' | 'PJ',
    };
  })
  .refine(
    (valor) => valor.documento.length === 11 || valor.documento.length === 14,
    MENSAGEM_DOCUMENTO_INVALIDO,
  );

export type CadinSalvadorParams = z.infer<typeof cadinSalvadorInputSchema>;

const artefatosEscolhaSchema = z.enum(['nenhum', 'pdf', 'print', 'ambos']);

type ArtefatosEscolha = z.infer<typeof artefatosEscolhaSchema>;

interface PendenciaBruta {
  tipo: string;
  descricao: string;
  valor: string;
  vencimento: string;
  situacao: string;
}

interface CadinBruto {
  mensagem: string;
  nome: string;
  cpfCnpj: string;
  totalPendencias: string;
  semPendencia: boolean;
  pendencias: PendenciaBruta[];
  textoBruto: string;
}

export interface PendenciaRelatorio {
  tipo: string;
  descricao: string;
  valor: string;
  vencimento: string;
  situacao: string;
}

export interface DadosRelatorioCadin {
  tipoDocumento: string;
  numeroDocumento: string;
  nome: string;
  cpfCnpj: string;
  totalPendencias: number;
  valorTotal: string;
  dataConsulta: string;
  mensagemPortal: string;
  pendencias: PendenciaRelatorio[];
}

interface ElementoPagina {
  readonly textContent: string | null;
  querySelector(seletor: string): ElementoPagina | null;
  querySelectorAll(seletor: string): ListaNosPagina;
}

interface ListaNosPagina {
  readonly length: number;
  item(indice: number): ElementoPagina | null;
}

interface DocumentoPagina {
  getElementById(id: string): ElementoPagina | null;
  querySelector(seletor: string): ElementoPagina | null;
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
    configPortal = await carregarPortalConfig('cadin-salvador');
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

function extrairCadin(): CadinBruto {
  const aplainar = (texto: string): string =>
    texto.replace(/\u00a0/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const porId = (id: string): string => {
    const elemento = document.getElementById(id);
    return aplainar(elemento?.textContent ?? '');
  };
  const mensagem = porId('ctl00_ContentPlaceHolder1_lblMensagem');
  const textoSemPendencia = porId('ctl00_ContentPlaceHolder1_h2SMsgSemPedencia');
  const semPendencia =
    textoSemPendencia !== '' ||
    /sem pend[eê]ncia|nada consta|n[ãa]o h[áa] pend[eê]ncia|cadin regular/i.test(mensagem);
  const pendencias: PendenciaBruta[] = [];
  const tabela = document.querySelector('#divResultado table');
  const linhas = tabela?.querySelectorAll('tr') ?? null;
  if (linhas !== null) {
    for (let i = 0; i < linhas.length; i += 1) {
      const linha = linhas.item(i);
      if (linha === null || linha.querySelector('th') !== null) {
        continue;
      }
      const celulas = linha.querySelectorAll('td');
      if (celulas.length === 0) {
        continue;
      }
      const celula = (indice: number): string => aplainar(celulas.item(indice)?.textContent ?? '');
      pendencias.push({
        tipo: celula(0),
        descricao: celula(1),
        valor: celula(2),
        vencimento: celula(3),
        situacao: celula(4),
      });
    }
  }
  return {
    mensagem,
    nome: porId('ctl00_ContentPlaceHolder1_lblNome'),
    cpfCnpj: porId('ctl00_ContentPlaceHolder1_lblCPFCNPJ'),
    totalPendencias: porId('ctl00_ContentPlaceHolder1_lblTotalPendencias'),
    semPendencia,
    pendencias,
    textoBruto: document.body?.innerText ?? '',
  };
}

function parseValorBr(valor: string): number | null {
  const limpo = valor.replace(/\s/g, '');
  if (limpo === '' || limpo === '-' || limpo === '—') {
    return null;
  }
  const numero = Number.parseFloat(limpo.replace(/\./g, '').replace(',', '.'));
  return Number.isNaN(numero) ? null : numero;
}

function formatarMoeda(valor: number): string {
  return `R$ ${valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escaparHtml(valor: string): string {
  return valor
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function montarRelatorioCadinHtml(dados: DadosRelatorioCadin): string {
  const linhas = dados.pendencias
    .map(
      (pendencia, indice) => `
      <tr${indice % 2 === 0 ? '' : ' style="background-color: #F8F9FA;"'}>
        <td style="padding: 8px 12px; border: 1px solid #DEE2E6; font-size: 10pt;">${escaparHtml(pendencia.tipo)}</td>
        <td style="padding: 8px 12px; border: 1px solid #DEE2E6; font-size: 10pt;">${escaparHtml(pendencia.descricao)}</td>
        <td style="padding: 8px 12px; border: 1px solid #DEE2E6; font-size: 10pt; text-align: right;">${escaparHtml(pendencia.valor)}</td>
        <td style="padding: 8px 12px; border: 1px solid #DEE2E6; font-size: 10pt; text-align: center;">${escaparHtml(pendencia.vencimento)}</td>
        <td style="padding: 8px 12px; border: 1px solid #DEE2E6; font-size: 10pt;">${escaparHtml(pendencia.situacao)}</td>
      </tr>`,
    )
    .join('');
  const corpo =
    dados.pendencias.length > 0
      ? `
  <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
    <thead>
      <tr style="background-color: #1A3A5C; color: white;">
        <th style="padding: 10px 12px; border: 1px solid #1A3A5C; text-align: left; font-size: 10pt;">Tipo</th>
        <th style="padding: 10px 12px; border: 1px solid #1A3A5C; text-align: left; font-size: 10pt;">Descrição</th>
        <th style="padding: 10px 12px; border: 1px solid #1A3A5C; text-align: right; font-size: 10pt;">Valor</th>
        <th style="padding: 10px 12px; border: 1px solid #1A3A5C; text-align: center; font-size: 10pt;">Vencimento</th>
        <th style="padding: 10px 12px; border: 1px solid #1A3A5C; text-align: left; font-size: 10pt;">Situação</th>
      </tr>
    </thead>
    <tbody>
      ${linhas}
    </tbody>
  </table>
  <div style="display: flex; justify-content: space-between; padding: 10px 12px; background-color: #FFF3E0; border: 1px solid #FB8C00; border-radius: 6px; margin-bottom: 20px;">
    <span><strong>Total de pendências:</strong> ${dados.totalPendencias}</span>
    <span><strong>Valor total:</strong> ${escaparHtml(dados.valorTotal)}</span>
  </div>`
      : `
  <div style="text-align: center; padding: 40px 20px; background-color: #E8F5E9; border: 2px solid #4CAF50; border-radius: 8px;">
    <h3 style="color: #2E7D32; margin: 8px 0; font-size: 14pt;">NENHUMA PENDÊNCIA ENCONTRADA</h3>
    <p style="color: #388E3C; font-size: 11pt;">CADIN REGULAR - Situação regular perante o CADIN Municipal</p>
  </div>`;
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Relatório CADIN Salvador</title></head><body style="font-family: Arial, sans-serif; margin: 0; padding: 20mm; color: #212529; font-size: 10pt;">
  <div style="text-align: center; margin-bottom: 20px; border-bottom: 3px solid #1A3A5C; padding-bottom: 15px;">
    <h1 style="color: #1A3A5C; margin: 5px 0; font-size: 16pt;">Prefeitura Municipal de Salvador</h1>
    <h2 style="color: #FB8C00; margin: 5px 0; font-size: 13pt;">CADIN - Cadastro de Inadimplentes</h2>
  </div>
  <div style="margin-bottom: 20px; padding: 12px; background-color: #F0F4F8; border-radius: 6px; border-left: 4px solid #1A3A5C;">
    <p style="margin: 4px 0;"><strong>Contribuinte:</strong> ${escaparHtml(dados.nome)}</p>
    <p style="margin: 4px 0;"><strong>${dados.tipoDocumento === 'PF' ? 'CPF' : 'CNPJ'}:</strong> ${escaparHtml(dados.numeroDocumento)}</p>
    <p style="margin: 4px 0;"><strong>Data da consulta:</strong> ${escaparHtml(dados.dataConsulta)}</p>
    <p style="margin: 4px 0;"><strong>Mensagem do portal:</strong> ${escaparHtml(dados.mensagemPortal)}</p>
  </div>
  ${corpo}
  <div style="margin-top: 30px; padding-top: 10px; border-top: 1px solid #DEE2E6; text-align: center; color: #6C757D; font-size: 8pt;">
    <p>Documento gerado automaticamente a partir dos dados extraídos do portal do CADIN Salvador</p>
    <p>Data da emissão: ${escaparHtml(dados.dataConsulta)}</p>
  </div>
</body></html>`;
}

function normalizarDados(
  documento: string,
  tipoDocumento: 'PF' | 'PJ',
  brutos: CadinBruto,
): Record<string, unknown> {
  const pendencias = brutos.pendencias
    .filter((pendencia) => pendencia.descricao !== '' || pendencia.tipo !== '')
    .map((pendencia) => ({
      tipo: pendencia.tipo,
      descricao: pendencia.descricao,
      valor: pendencia.valor,
      valorNumerico: parseValorBr(pendencia.valor),
      vencimento: pendencia.vencimento,
      situacao: pendencia.situacao,
    }));
  const total = Number.parseInt(brutos.totalPendencias, 10);
  const valorTotal = pendencias.reduce((soma, pendencia) => soma + (pendencia.valorNumerico ?? 0), 0);
  const temPendencias = !brutos.semPendencia && pendencias.length > 0;
  return {
    tipoDocumento,
    numeroDocumento: documento,
    nome: brutos.nome,
    cpfCnpj: brutos.cpfCnpj,
    mensagemPortal: brutos.mensagem,
    totalPendencias: Number.isNaN(total) ? pendencias.length : total,
    valorTotal: Math.round(valorTotal * 100) / 100,
    temPendencias,
    pendencias,
    dataConsulta: new Date().toLocaleDateString('pt-BR'),
  };
}

function montarDadosRelatorio(dados: Record<string, unknown>): DadosRelatorioCadin {
  const pendencias = (dados['pendencias'] as Array<Record<string, string>>).map((pendencia) => ({
    tipo: pendencia['tipo'] ?? '',
    descricao: pendencia['descricao'] ?? '',
    valor: pendencia['valor'] ?? '',
    vencimento: pendencia['vencimento'] ?? '',
    situacao: pendencia['situacao'] ?? '',
  }));
  const valorTotal = typeof dados['valorTotal'] === 'number' ? dados['valorTotal'] : 0;
  return {
    tipoDocumento: String(dados['tipoDocumento'] ?? ''),
    numeroDocumento: String(dados['numeroDocumento'] ?? ''),
    nome: String(dados['nome'] ?? ''),
    cpfCnpj: String(dados['cpfCnpj'] ?? ''),
    totalPendencias: typeof dados['totalPendencias'] === 'number' ? dados['totalPendencias'] : 0,
    valorTotal: formatarMoeda(valorTotal),
    dataConsulta: String(dados['dataConsulta'] ?? ''),
    mensagemPortal: String(dados['mensagemPortal'] ?? ''),
    pendencias,
  };
}

export class CadinSalvadorRobot extends BaseRobot {
  readonly tipo = 'cadin-salvador';
  readonly nome = 'CADIN Salvador';
  readonly portal = 'PREF_SALVADOR';
  private ultimaCargaPaginaMs = 0;

  async executar(params: Record<string, unknown>, ctx: ExecucaoCtx): Promise<ResultadoRobot> {
    const entrada = cadinSalvadorInputSchema.safeParse(params);
    if (!entrada.success) {
      throw new ValidationError(MENSAGEM_DOCUMENTO_INVALIDO, entrada.error.flatten());
    }
    const { documento, tipoDocumento } = entrada.data;
    try {
      const config = await obterConfigPortal();
      const cadeias = extrairCadeias(config);
      const pagina = ctx.sessao.page;
      this.emitir(ctx, 'log', `Iniciando consulta CADIN Salvador para o documento ${documento}`);
      await this.navegar(pagina, ctx, config);
      await this.selecionarTipoDocumento(pagina, ctx, cadeias, tipoDocumento);
      await this.preencherDocumento(pagina, ctx, cadeias, documento);
      await this.submeterConsulta(pagina, ctx, cadeias, documento, tipoDocumento);
      const brutos = await this.extrairDados(pagina, ctx);
      const dados = normalizarDados(documento, tipoDocumento, brutos);
      await this.gerarArtefatos(pagina, ctx, documento, montarDadosRelatorio(dados));
      if (brutos.mensagem === '') {
        return {
          sucesso: true,
          dados,
          mensagem: 'Documento não encontrado no CADIN Salvador para o documento informado.',
        };
      }
      if (dados['temPendencias'] !== true) {
        return {
          sucesso: true,
          dados,
          mensagem: 'Nenhuma pendência encontrada no CADIN Salvador para o documento informado.',
        };
      }
      this.emitir(
        ctx,
        'log',
        `Consulta concluída: ${String(dados['totalPendencias'])} pendência(s) para o documento ${documento}`,
      );
      return {
        sucesso: true,
        dados,
        mensagem: 'Consulta CADIN Salvador realizada com sucesso.',
      };
    } catch (erro) {
      this.emitir(ctx, 'error', mensagemDeErro(erro));
      throw erro;
    }
  }

  private async navegar(pagina: Page, ctx: ExecucaoCtx, config: PortalConfig): Promise<void> {
    exigirTempo(ctx.signal, 'navegar-portal');
    this.emitir(ctx, 'log', 'Acessando o portal do CADIN Salvador');
    try {
      await pagina.goto(config.navegacao.url, {
        waitUntil: config.navegacao.waitUntil,
        timeout: TIMEOUT_NAVEGACAO_MS,
      });
      await this.aguardarQuiescenciaRede(pagina, ctx);
      this.ultimaCargaPaginaMs = Date.now();
    } catch (erro) {
      throw normalizarErro('navegar-portal', erro);
    }
  }

  private async aguardarQuiescenciaRede(pagina: Page, ctx: ExecucaoCtx): Promise<void> {
    exigirTempo(ctx.signal, 'navegar-portal');
    try {
      await pagina.waitForLoadState('networkidle', { timeout: TIMEOUT_QUIESCENCIA_REDE_MS });
    } catch {
      this.emitir(
        ctx,
        'warn',
        'Página do CADIN segue com tráfego de rede — seguindo com a imagem atual.',
      );
    }
  }

  private async selecionarTipoDocumento(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
    tipoDocumento: 'PF' | 'PJ',
  ): Promise<void> {
    exigirTempo(ctx.signal, 'selecionar-tipo-documento');
    this.emitir(ctx, 'log', `Selecionando o tipo de documento ${tipoDocumento}`);
    try {
      const chave = tipoDocumento === 'PF' ? 'radio_pf' : 'radio_pj';
      const opcao = await localizarPorChave(pagina, chave, cadeias, 'selecionar-tipo-documento');
      const marcada = await opcao.isChecked().catch(() => false);
      if (marcada) {
        this.emitir(ctx, 'log', `Tipo de documento ${tipoDocumento} já selecionado`);
        return;
      }
      const captchaAnterior = await this.fonteCaptchaAtual(pagina, cadeias);
      await opcao.check({ force: true }).catch(() => opcao.click({ force: true }));
      await this.aguardarTrocaCaptcha(pagina, ctx, cadeias, captchaAnterior);
    } catch (erro) {
      throw normalizarErro('selecionar-tipo-documento', erro);
    }
  }

  private async preencherDocumento(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
    documento: string,
  ): Promise<void> {
    exigirTempo(ctx.signal, 'preencher-documento');
    this.emitir(ctx, 'log', 'Preenchendo o documento para consulta');
    try {
      const campo = await localizarPorChave(pagina, 'campo_documento', cadeias, 'preencher-documento');
      await campo.fill('');
      await campo.fill(documento);
    } catch (erro) {
      throw normalizarErro('preencher-documento', erro);
    }
  }

  private async resolverCaptchaEtapa(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
    documento: string,
  ): Promise<LeituraCaptcha> {
    exigirTempo(ctx.signal, 'resolver-captcha');
    this.emitir(ctx, 'log', 'Resolvendo o captcha do portal');
    try {
      const seletores: string[] = cadeias['imagem_captcha']?.seletores ?? [];
      const imagem = await detectarCaptchaImagem(pagina, seletores);
      if (imagem === null) {
        throw new EtapaError(
          'resolver-captcha',
          'Captcha não detectado: a imagem do captcha não apareceu na página.',
        );
      }
      const diretorio = path.join(tmpdir(), 'api-sefaz-ssa', `cadin-salvador-${documento}`);
      await mkdir(diretorio, { recursive: true });
      const caminhoImagem = path.join(diretorio, 'captcha.png');
      await this.aguardarImagemCaptcha(pagina, ctx, imagem);
      const guid = await this.aguardarCaptchaEstavel(pagina, ctx, cadeias);
      await imagem.screenshot({ path: caminhoImagem });
      const codigo = (await decodificarCaptcha(caminhoImagem)).trim();
      if (codigo === '') {
        throw new EtapaError('resolver-captcha', 'Captcha não resolvido: o resolvedor retornou texto vazio.');
      }
      const campo = await localizarPorChave(pagina, 'campo_captcha', cadeias, 'resolver-captcha');
      await campo.fill('');
      await campo.fill(codigo);
      return { codigo, caminhoImagem, guid };
    } catch (erro) {
      throw normalizarErro('resolver-captcha', erro);
    }
  }

  private async aguardarImagemCaptcha(
    pagina: Page,
    ctx: ExecucaoCtx,
    imagem: NonNullable<Awaited<ReturnType<typeof detectarCaptchaImagem>>>,
  ): Promise<void> {
    exigirTempo(ctx.signal, 'resolver-captcha');
    const inicio = Date.now();
    while (Date.now() - inicio < TIMEOUT_IMAGEM_CAPTCHA_MS) {
      exigirTempo(ctx.signal, 'resolver-captcha');
      const carregada = await imagem
        .evaluate((elemento) => {
          const figura = elemento as unknown as Record<string, unknown>;
          const completa = figura['complete'] === true;
          const largura = figura['naturalWidth'];
          return completa && typeof largura === 'number' && largura > 0;
        })
        .catch(() => false);
      if (carregada) {
        return;
      }
      await pagina.waitForTimeout(INTERVALO_IMAGEM_CAPTCHA_MS);
    }
    throw new EtapaError(
      'resolver-captcha',
      'Imagem do captcha não carregou: a figura não terminou de baixar antes da leitura.',
    );
  }

  private async aguardarCaptchaEstavel(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
  ): Promise<string | null> {
    exigirTempo(ctx.signal, 'resolver-captcha');
    let anterior: string | null = null;
    let iguais = 0;
    const limite = LEITURAS_ESTABILIDADE_CAPTCHA + 4;
    for (let leitura = 0; leitura < limite; leitura += 1) {
      exigirTempo(ctx.signal, 'resolver-captcha');
      const atual = await this.fonteCaptchaAtual(pagina, cadeias);
      if (atual !== null && atual === anterior) {
        iguais += 1;
        if (iguais >= LEITURAS_ESTABILIDADE_CAPTCHA) {
          return atual;
        }
      } else {
        anterior = atual;
        iguais = atual === null ? 0 : 1;
      }
      await pagina.waitForTimeout(INTERVALO_ESTABILIDADE_CAPTCHA_MS);
    }
    this.emitir(
      ctx,
      'warn',
      'Imagem do captcha segue trocando antes da leitura — seguindo com a fonte atual.',
    );
    return anterior;
  }

  private async aguardarIdadeMinimaPagina(pagina: Page, ctx: ExecucaoCtx): Promise<number> {
    exigirTempo(ctx.signal, 'submeter-consulta');
    const idade = Date.now() - this.ultimaCargaPaginaMs;
    if (this.ultimaCargaPaginaMs === 0 || idade >= IDADE_MINIMA_PAGINA_MS) {
      return idade;
    }
    await pagina.waitForTimeout(IDADE_MINIMA_PAGINA_MS - idade);
    return Date.now() - this.ultimaCargaPaginaMs;
  }

  private async fotografarCaptchaPreSubmit(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
    documento: string,
    tentativa: number,
  ): Promise<string | null> {
    exigirTempo(ctx.signal, 'submeter-consulta');
    try {
      const seletores: string[] = cadeias['imagem_captcha']?.seletores ?? [];
      const imagem = await detectarCaptchaImagem(pagina, seletores);
      if (imagem === null) {
        return null;
      }
      try {
        const diretorio = path.join(tmpdir(), 'api-sefaz-ssa', `cadin-salvador-${documento}`);
        await mkdir(diretorio, { recursive: true });
        const caminho = path.join(diretorio, `captcha-pre-t${String(tentativa)}.png`);
        await imagem.screenshot({ path: caminho });
        return caminho;
      } finally {
        await imagem.dispose().catch(() => undefined);
      }
    } catch {
      return null;
    }
  }

  private async submeterConsulta(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
    documento: string,
    tipoDocumento: 'PF' | 'PJ',
  ): Promise<void> {
    exigirTempo(ctx.signal, 'submeter-consulta');
    this.emitir(ctx, 'log', 'Submetendo a consulta e aguardando o resultado');
    const requisicoes: RequisicaoDiag[] = [];
    const aoObservarRequisicao = (requisicao: RequisicaoPlaywright): void => {
      const url = requisicao.url();
      if (url.includes('CaptchaImage') || url.includes('default.aspx')) {
        requisicoes.push({
          ms: Date.now(),
          metodo: requisicao.method(),
          url,
          postado: requisicao.method() === 'POST' ? extrairCaptchaPostado(requisicao) : '',
        });
      }
    };
    if (diagAtivo()) {
      pagina.on('request', aoObservarRequisicao);
    }
    try {
      let tentativa = 1;
      let refrescos = 0;
      while (tentativa <= MAX_TENTATIVAS_CAPTCHA) {
        exigirTempo(ctx.signal, 'submeter-consulta');
        const inicioTentativa = Date.now();
        const indiceRequisicoes = requisicoes.length;
        let leitura: LeituraCaptcha;
        try {
          leitura = await this.resolverCaptchaEtapa(pagina, ctx, cadeias, documento);
        } catch (erro) {
          if (ehErroCaptchaVazio(erro) && refrescos < MAX_REFRESCOS_CAPTCHA) {
            refrescos += 1;
            this.emitir(
              ctx,
              'warn',
              `Leitura do captcha abaixo da qualidade na tentativa ${String(tentativa)} — renovando a imagem ${String(refrescos)} de ${String(MAX_REFRESCOS_CAPTCHA)}.`,
            );
            await this.renovarCaptcha(pagina, ctx, cadeias, tipoDocumento, documento);
            continue;
          }
          throw erro;
        }
        const botao = await localizarPorChave(pagina, 'botao_consultar', cadeias, 'submeter-consulta');
        const captchaAnterior = await this.fonteCaptchaAtual(pagina, cadeias);
        const guidPreClick = somenteGuid(captchaAnterior);
        const imagemEstavel = guidPreClick !== null && guidPreClick === somenteGuid(leitura.guid);
        const tamanhoValido = leitura.codigo.length === TAMANHO_CODIGO_CAPTCHA;
        if ((!imagemEstavel || !tamanhoValido) && refrescos < MAX_REFRESCOS_CAPTCHA) {
          refrescos += 1;
          const motivo = !imagemEstavel
            ? 'a imagem trocou durante a leitura'
            : `a leitura veio com ${String(leitura.codigo.length)} de ${String(TAMANHO_CODIGO_CAPTCHA)} caracteres`;
          this.emitir(
            ctx,
            'warn',
            `Leitura do captcha descartada na tentativa ${String(tentativa)} (${motivo}) — renovando a imagem ${String(refrescos)} de ${String(MAX_REFRESCOS_CAPTCHA)}.`,
          );
          if (diagAtivo()) {
            await this.registrarDiagDescarte(documento, tentativa, motivo, leitura);
          }
          await this.renovarCaptcha(pagina, ctx, cadeias, tipoDocumento, documento);
          continue;
        }
        let codigoEnviado = leitura.codigo;
        let caminhoPreSubmit = '';
        let ocrPreSubmit = leitura.codigo;
        let preIgualLida = true;
        const fotoPreSubmit = await this.fotografarCaptchaPreSubmit(
          pagina,
          ctx,
          cadeias,
          documento,
          tentativa,
        );
        if (fotoPreSubmit !== null) {
          caminhoPreSubmit = fotoPreSubmit;
          preIgualLida = await arquivosIguais(leitura.caminhoImagem, fotoPreSubmit);
          if (!preIgualLida) {
            const releitura = await decodificarCaptcha(fotoPreSubmit)
              .catch(() => '')
              .then((texto) => texto.trim());
            if (releitura === '') {
              if (refrescos < MAX_REFRESCOS_CAPTCHA) {
                refrescos += 1;
                const motivo = 'a imagem trocou antes do envio e a releitura veio vazia';
                this.emitir(
                  ctx,
                  'warn',
                  `Leitura do captcha descartada na tentativa ${String(tentativa)} (${motivo}) — renovando a imagem ${String(refrescos)} de ${String(MAX_REFRESCOS_CAPTCHA)}.`,
                );
                if (diagAtivo()) {
                  await this.registrarDiagDescarte(documento, tentativa, motivo, leitura);
                }
                await this.renovarCaptcha(pagina, ctx, cadeias, tipoDocumento, documento);
                continue;
              }
            } else {
              codigoEnviado = releitura;
              ocrPreSubmit = releitura;
              const campo = await localizarPorChave(pagina, 'campo_captcha', cadeias, 'submeter-consulta');
              await campo.fill('');
              await campo.fill(releitura);
              this.emitir(
                ctx,
                'warn',
                `Imagem do captcha trocou antes do envio na tentativa ${String(tentativa)} — relendo e enviando a leitura nova.`,
              );
            }
          }
        }
        const valorNoCampo = diagAtivo() ? await this.valorCampoCaptcha(pagina, cadeias) : '';
        const docValorPre = diagAtivo() ? await this.valorCampoDocumento(pagina, cadeias) : '';
        const docHabilitadoPre = diagAtivo()
          ? await this.campoDocumentoHabilitado(pagina, cadeias)
          : false;
        const idadePaginaMs = await this.aguardarIdadeMinimaPagina(pagina, ctx);
        await botao.click();
        const guidNoSubmit = diagAtivo() ? await this.fonteCaptchaAtual(pagina, cadeias) : null;
        exigirTempo(ctx.signal, 'aguardar-resultado');
        const desfecho = await this.aguardarResultadoOuErro(pagina, ctx, cadeias, captchaAnterior);
        if (diagAtivo()) {
          await this.registrarDiagTentativa(pagina, cadeias, documento, tentativa, {
            guidLido: somenteGuid(leitura.guid),
            codigoOcr: leitura.codigo,
            caminhoImagem: leitura.caminhoImagem,
            caminhoPreSubmit,
            ocrPreSubmit,
            codigoEnviado,
            preIgualLida,
            idadePaginaMs,
            valorNoCampo,
            guidPreClick,
            docValorPre,
            docHabilitadoPre,
            guidNoSubmit: somenteGuid(guidNoSubmit),
            requisicoes: requisicoes.slice(indiceRequisicoes),
            inicioTentativa,
          });
        }
        if (desfecho === 'resultado') {
          return;
        }
        this.emitir(
          ctx,
          'warn',
          `O portal rejeitou o código do captcha na tentativa ${String(tentativa)} de ${String(MAX_TENTATIVAS_CAPTCHA)} — recarregando a página para nova imagem.`,
        );
        if (tentativa < MAX_TENTATIVAS_CAPTCHA) {
          await this.renovarCaptcha(pagina, ctx, cadeias, tipoDocumento, documento);
        }
        tentativa += 1;
      }
      throw new EtapaError(
        'aguardar-resultado',
        `Captcha rejeitado pelo portal após ${String(MAX_TENTATIVAS_CAPTCHA)} tentativas: o código digitado não confere com a imagem.`,
      );
    } catch (erro) {
      throw normalizarErro('aguardar-resultado', erro);
    } finally {
      if (diagAtivo()) {
        pagina.off('request', aoObservarRequisicao);
      }
    }
  }

  private async renovarCaptcha(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
    tipoDocumento: 'PF' | 'PJ',
    documento: string,
  ): Promise<void> {
    exigirTempo(ctx.signal, 'resolver-captcha');
    try {
      const config = await obterConfigPortal();
      await pagina.goto(config.navegacao.url, {
        waitUntil: config.navegacao.waitUntil,
        timeout: TIMEOUT_NAVEGACAO_MS,
      });
      await this.aguardarQuiescenciaRede(pagina, ctx);
      this.ultimaCargaPaginaMs = Date.now();
      await this.selecionarTipoDocumento(pagina, ctx, cadeias, tipoDocumento);
      await this.preencherDocumento(pagina, ctx, cadeias, documento);
    } catch (erro) {
      throw normalizarErro('resolver-captcha', erro);
    }
  }

  private async fonteCaptchaAtual(
    pagina: Page,
    cadeias: Record<string, CadeiaSeletores>,
  ): Promise<string | null> {
    const seletores = cadeias['imagem_captcha']?.seletores ?? [];
    const alvo = seletores[0] ?? 'img[src*="captcha" i]';
    const localizador = pagina.locator(alvo).first();
    const quantidade = await localizador.count().catch(() => 0);
    if (quantidade === 0) {
      return null;
    }
    return localizador.getAttribute('src', { timeout: 2000 }).catch(() => null);
  }

  private async valorCampoCaptcha(
    pagina: Page,
    cadeias: Record<string, CadeiaSeletores>,
  ): Promise<string> {
    const seletores = cadeias['campo_captcha']?.seletores ?? [];
    for (const seletor of seletores) {
      const valor = await pagina
        .locator(seletor)
        .first()
        .inputValue({ timeout: 2000 })
        .catch(() => null);
      if (valor !== null) {
        return valor;
      }
    }
    return '';
  }

  private async valorCampoDocumento(
    pagina: Page,
    cadeias: Record<string, CadeiaSeletores>,
  ): Promise<string> {
    const seletores = cadeias['campo_documento']?.seletores ?? [];
    for (const seletor of seletores) {
      const valor = await pagina
        .locator(seletor)
        .first()
        .inputValue({ timeout: 2000 })
        .catch(() => null);
      if (valor !== null) {
        return valor;
      }
    }
    return '';
  }

  private async campoDocumentoHabilitado(
    pagina: Page,
    cadeias: Record<string, CadeiaSeletores>,
  ): Promise<boolean> {
    const seletores = cadeias['campo_documento']?.seletores ?? [];
    for (const seletor of seletores) {
      const habilitado = await pagina
        .locator(seletor)
        .first()
        .isEnabled({ timeout: 2000 })
        .catch(() => null);
      if (habilitado !== null) {
        return habilitado;
      }
    }
    return false;
  }

  private async textoErroCaptchaAtual(
    pagina: Page,
    cadeias: Record<string, CadeiaSeletores>,
  ): Promise<string> {
    const seletores = cadeias['erro_captcha']?.seletores ?? [];
    for (const seletor of seletores) {
      const texto = await pagina
        .locator(seletor)
        .first()
        .textContent({ timeout: 2000 })
        .catch(() => null);
      if (texto !== null && texto.trim() !== '') {
        return texto.replace(/\s{2,}/g, ' ').trim();
      }
    }
    return '';
  }

  private async registrarDiagTentativa(
    pagina: Page,
    cadeias: Record<string, CadeiaSeletores>,
    documento: string,
    tentativa: number,
    leitura: {
      guidLido: string | null;
      codigoOcr: string;
      caminhoImagem: string;
      caminhoPreSubmit: string;
      ocrPreSubmit: string;
      codigoEnviado: string;
      preIgualLida: boolean;
      idadePaginaMs: number;
      valorNoCampo: string;
      guidPreClick: string | null;
      docValorPre: string;
      docHabilitadoPre: boolean;
      guidNoSubmit: string | null;
      requisicoes: RequisicaoDiag[];
      inicioTentativa: number;
    },
  ): Promise<void> {
    try {
      await mkdir(DIRETORIO_DIAG, { recursive: true });
      const prefixo = `cadin-diag-${documento}-t${String(tentativa).padStart(2, '0')}-${String(Date.now())}`;
      const imagemLida = `${prefixo}-lida.png`;
      await readFile(leitura.caminhoImagem)
        .then((conteudo) => writeFile(path.join(DIRETORIO_DIAG, imagemLida), conteudo))
        .catch(() => undefined);
      let imagemPreSubmit = '';
      if (leitura.caminhoPreSubmit !== '') {
        imagemPreSubmit = `${prefixo}-pre.png`;
        await readFile(leitura.caminhoPreSubmit)
          .then((conteudo) => writeFile(path.join(DIRETORIO_DIAG, imagemPreSubmit), conteudo))
          .catch(() => undefined);
      }
      const guidPosSubmit = somenteGuid(await this.fonteCaptchaAtual(pagina, cadeias));
      const erroPortal = await this.textoErroCaptchaAtual(pagina, cadeias);
      let imagemPosSubmit = '';
      const seletores: string[] = cadeias['imagem_captcha']?.seletores ?? [];
      const imagem = await detectarCaptchaImagem(pagina, seletores).catch(() => null);
      if (imagem !== null) {
        imagemPosSubmit = `${prefixo}-pos.png`;
        await imagem
          .screenshot({ path: path.join(DIRETORIO_DIAG, imagemPosSubmit) })
          .catch(() => undefined);
        await imagem.dispose().catch(() => undefined);
      }
      const caminhoPosSubmit =
        imagemPosSubmit === '' ? '' : path.join(DIRETORIO_DIAG, imagemPosSubmit);
      const ocrPosSubmit =
        caminhoPosSubmit === ''
          ? ''
          : await decodificarCaptcha(caminhoPosSubmit)
              .catch(() => '')
              .then((texto) => texto.trim());
      const registro: RegistroDiagTentativa = {
        evento: 'envio',
        tentativa,
        documento,
        motivoDescarte: '',
        guidLido: leitura.guidLido,
        codigoOcr: leitura.codigoOcr,
        codigoEnviado: leitura.codigoEnviado,
        valorNoCampo: leitura.valorNoCampo,
        guidPreClick: leitura.guidPreClick,
        docValorPre: leitura.docValorPre,
        docHabilitadoPre: leitura.docHabilitadoPre,
        guidNoSubmit: leitura.guidNoSubmit,
        guidPosSubmit,
        erroPortal,
        imagemLida,
        imagemPreSubmit,
        imagemPosSubmit,
        hashLida: await lerHashArquivo(path.join(DIRETORIO_DIAG, imagemLida)),
        hashPreSubmit: await lerHashArquivo(
          imagemPreSubmit === '' ? '' : path.join(DIRETORIO_DIAG, imagemPreSubmit),
        ),
        hashPosSubmit: await lerHashArquivo(caminhoPosSubmit),
        preIgualLida: leitura.preIgualLida,
        idadePaginaMs: leitura.idadePaginaMs,
        ocrPreSubmit: leitura.ocrPreSubmit,
        ocrPosSubmit,
        requisicoes: leitura.requisicoes.map((requisicao) => ({
          ms: requisicao.ms - leitura.inicioTentativa,
          metodo: requisicao.metodo,
          url: requisicao.url,
          postado: requisicao.postado,
        })),
      };
      await appendFile(
        path.join(DIRETORIO_DIAG, ARQUIVO_DIAG_TENTATIVAS),
        `${JSON.stringify(registro)}\n`,
        'utf-8',
      ).catch(() => undefined);
    } catch {
      return;
    }
  }

  private async registrarDiagDescarte(
    documento: string,
    tentativa: number,
    motivo: string,
    leitura: LeituraCaptcha,
  ): Promise<void> {
    try {
      await mkdir(DIRETORIO_DIAG, { recursive: true });
      const prefixo = `cadin-diag-${documento}-t${String(tentativa).padStart(2, '0')}-${String(Date.now())}`;
      const imagemLida = `${prefixo}-lida.png`;
      await readFile(leitura.caminhoImagem)
        .then((conteudo) => writeFile(path.join(DIRETORIO_DIAG, imagemLida), conteudo))
        .catch(() => undefined);
      const registro: RegistroDiagTentativa = {
        evento: 'descarte',
        tentativa,
        documento,
        motivoDescarte: motivo,
        guidLido: somenteGuid(leitura.guid),
        codigoOcr: leitura.codigo,
        codigoEnviado: '',
        valorNoCampo: '',
        guidPreClick: null,
        docValorPre: '',
        docHabilitadoPre: false,
        guidNoSubmit: null,
        guidPosSubmit: null,
        erroPortal: '',
        imagemLida,
        imagemPreSubmit: '',
        imagemPosSubmit: '',
        hashLida: await lerHashArquivo(path.join(DIRETORIO_DIAG, imagemLida)),
        hashPreSubmit: '',
        hashPosSubmit: '',
        preIgualLida: false,
        idadePaginaMs: 0,
        ocrPreSubmit: '',
        ocrPosSubmit: '',
        requisicoes: [],
      };
      await appendFile(
        path.join(DIRETORIO_DIAG, ARQUIVO_DIAG_TENTATIVAS),
        `${JSON.stringify(registro)}\n`,
        'utf-8',
      ).catch(() => undefined);
    } catch {
      return;
    }
  }

  private async aguardarTrocaCaptcha(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
    anterior: string | null,
  ): Promise<void> {
    const inicio = Date.now();
    while (Date.now() - inicio < TIMEOUT_TROCA_CAPTCHA_MS) {
      exigirTempo(ctx.signal, 'selecionar-tipo-documento');
      const atual = await this.fonteCaptchaAtual(pagina, cadeias);
      if (anterior === null || (atual !== null && atual !== anterior)) {
        return;
      }
      await pagina.waitForTimeout(INTERVALO_SONDAGEM_RESULTADO_MS);
    }
    this.emitir(
      ctx,
      'warn',
      'Imagem do captcha não recarregou após a troca do tipo de documento — seguindo com a imagem atual.',
    );
  }

  private async cadeiaAnexada(
    pagina: Page,
    cadeia: CadeiaSeletores | undefined,
  ): Promise<boolean> {
    for (const seletor of cadeia?.seletores ?? []) {
      const quantidade = await pagina
        .locator(seletor)
        .first()
        .count()
        .catch(() => 0);
      if (quantidade > 0) {
        return true;
      }
    }
    return false;
  }

  private async aguardarResultadoOuErro(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
    captchaAnterior: string | null,
  ): Promise<'resultado' | 'captcha'> {
    exigirTempo(ctx.signal, 'aguardar-resultado');
    const inicio = Date.now();
    while (Date.now() - inicio < TIMEOUT_RESULTADO_POR_TENTATIVA_MS) {
      exigirTempo(ctx.signal, 'aguardar-resultado');
      if (await this.cadeiaAnexada(pagina, cadeias['bloco_resultado'])) {
        return 'resultado';
      }
      const captchaAtual = await this.fonteCaptchaAtual(pagina, cadeias);
      const respostaNova =
        captchaAtual !== null && captchaAnterior !== null && captchaAtual !== captchaAnterior;
      if (respostaNova && (await this.cadeiaAnexada(pagina, cadeias['erro_captcha']))) {
        return 'captcha';
      }
      await pagina.waitForTimeout(INTERVALO_SONDAGEM_RESULTADO_MS);
    }
    await localizarPorChave(pagina, 'bloco_resultado', cadeias, 'aguardar-resultado', 1000);
    return 'resultado';
  }

  private async extrairDados(pagina: Page, ctx: ExecucaoCtx): Promise<CadinBruto> {
    exigirTempo(ctx.signal, 'extrair-dados');
    this.emitir(ctx, 'log', 'Extraindo os dados do CADIN');
    try {
      return await pagina.evaluate(extrairCadin);
    } catch (erro) {
      throw normalizarErro('extrair-dados', erro);
    }
  }

  private async gerarArtefatos(
    pagina: Page,
    ctx: ExecucaoCtx,
    documento: string,
    relatorio: DadosRelatorioCadin,
  ): Promise<void> {
    exigirTempo(ctx.signal, 'gerar-artefatos');
    if (ctx.artefatos === 'nenhum') {
      return;
    }
    this.emitir(ctx, 'log', 'Gerando os artefatos da consulta');
    try {
      const diretorio = path.join(tmpdir(), 'api-sefaz-ssa', `cadin-salvador-${documento}`);
      await mkdir(diretorio, { recursive: true });
      if (ctx.artefatos === 'print' || ctx.artefatos === 'ambos') {
        const print = await pagina.screenshot({ type: 'jpeg', quality: 70, fullPage: true });
        const caminhoPrint = path.join(diretorio, 'print.jpg');
        await writeFile(caminhoPrint, print);
        ctx.registrarArquivo('print', caminhoPrint, 'image/jpeg');
      }
      if (ctx.artefatos === 'pdf' || ctx.artefatos === 'ambos') {
        const paginaRelatorio = await ctx.sessao.context.newPage();
        try {
          await paginaRelatorio.setContent(montarRelatorioCadinHtml(relatorio), {
            waitUntil: 'domcontentloaded',
          });
          const pdf = await paginaRelatorio.pdf({ format: 'A4', printBackground: true });
          const caminhoPdf = path.join(diretorio, 'relatorio.pdf');
          await writeFile(caminhoPdf, pdf);
          ctx.registrarArquivo('pdf_oficial', caminhoPdf, 'application/pdf');
        } finally {
          await paginaRelatorio.close().catch(() => undefined);
        }
      }
    } catch (erro) {
      throw normalizarErro('gerar-artefatos', erro);
    }
  }
}

function validarPayload(payload: string): {
  documento: string;
  tipoDocumento: 'PF' | 'PJ';
  artefatos: ArtefatosEscolha;
} {
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
  const entrada = cadinSalvadorInputSchema.safeParse(registro);
  if (!entrada.success) {
    throw new ValidationError(MENSAGEM_DOCUMENTO_INVALIDO, entrada.error.flatten());
  }
  const artefatos = artefatosEscolhaSchema.safeParse(registro['artefatos'] ?? 'nenhum');
  if (!artefatos.success) {
    throw new ValidationError('Opção de artefatos inválida: use nenhum, pdf, print ou ambos');
  }
  return { documento: entrada.data.documento, tipoDocumento: entrada.data.tipoDocumento, artefatos: artefatos.data };
}

export const executarCadinSalvador = async (
  execucao: Execucao,
  sessao: BrowserSession,
): Promise<ResultadoExecutor> => {
  const { documento, tipoDocumento, artefatos } = validarPayload(execucao.payload);
  const canal = obterCanalProgresso();
  const robo = new CadinSalvadorRobot();
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
    signal: AbortSignal.timeout(CADIN_SALVADOR_TIMEOUT_MS),
  };
  const resultado = await robo.executar({ documento, tipoDocumento }, ctx);
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

registrarExecutor('cadin-salvador', executarCadinSalvador);
