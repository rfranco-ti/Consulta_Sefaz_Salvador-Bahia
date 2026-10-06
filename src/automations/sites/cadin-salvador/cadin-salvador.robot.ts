import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
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

export const CADIN_SALVADOR_TIMEOUT_MS = 120000;

const TIMEOUT_NAVEGACAO_MS = 30000;
const TIMEOUT_RESULTADO_POR_TENTATIVA_MS = 8000;

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
      await this.resolverCaptchaEtapa(pagina, ctx, cadeias, documento);
      await this.submeterConsulta(pagina, ctx, cadeias);
      const brutos = await this.extrairDados(pagina, ctx);
      const dados = normalizarDados(documento, tipoDocumento, brutos);
      await this.gerarArtefatos(pagina, ctx, documento, montarDadosRelatorio(dados));
      if (brutos.mensagem === '') {
        return {
          sucesso: false,
          dados: { tipoDocumento, numeroDocumento: documento },
          mensagem: 'Documento não encontrado no CADIN Salvador para o documento informado.',
        };
      }
      if (dados['temPendencias'] !== true) {
        return {
          sucesso: false,
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
    } catch (erro) {
      throw normalizarErro('navegar-portal', erro);
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
      await opcao.check({ force: true }).catch(() => opcao.click({ force: true }));
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
  ): Promise<void> {
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
      await imagem.screenshot({ path: caminhoImagem });
      const codigo = (await decodificarCaptcha(caminhoImagem)).trim();
      if (codigo === '') {
        throw new EtapaError('resolver-captcha', 'Captcha não resolvido: o resolvedor retornou texto vazio.');
      }
      const campo = await localizarPorChave(pagina, 'campo_captcha', cadeias, 'resolver-captcha');
      await campo.fill('');
      await campo.fill(codigo);
    } catch (erro) {
      throw normalizarErro('resolver-captcha', erro);
    }
  }

  private async submeterConsulta(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
  ): Promise<void> {
    exigirTempo(ctx.signal, 'submeter-consulta');
    this.emitir(ctx, 'log', 'Submetendo a consulta e aguardando o resultado');
    try {
      const botao = await localizarPorChave(pagina, 'botao_consultar', cadeias, 'submeter-consulta');
      await botao.click();
      exigirTempo(ctx.signal, 'aguardar-resultado');
      await localizarPorChave(
        pagina,
        'bloco_resultado',
        cadeias,
        'aguardar-resultado',
        TIMEOUT_RESULTADO_POR_TENTATIVA_MS,
      );
    } catch (erro) {
      throw normalizarErro('aguardar-resultado', erro);
    }
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
