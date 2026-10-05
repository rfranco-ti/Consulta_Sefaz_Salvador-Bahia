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

export const DAM_TFF_TLL_TIMEOUT_MS = 300000;

const TIMEOUT_NAVEGACAO_MS = 30000;
const TIMEOUT_RESULTADO_POR_TENTATIVA_MS = 5000;
const TIMEOUT_EMISSAO_NAVEGACAO_MS = 30000;
const TIMEOUT_ABA_BOLETO_MS = 20000;
const JANELA_ESTABILIDADE_MS = 500;
const TIMEOUT_ESTABILIDADE_MS = 8000;
const TIMEOUT_ABA_MS = 2500;
const TIMEOUT_CONTEUDO_MS = 8000;
const TIMEOUT_EMBUTIDO_MS = 8000;
const ESPERA_SINAL_BOLETO_MS = 3000;
const POLL_CONDICAO_MS = 100;
const POLL_EMBUTIDO_MS = 300;
const LIMITE_TEXTO_PRONTO = 100;
const TENTATIVAS_RECONSULTA = 2;

const URL_NOVA_ABA_BOLETO = /DAMForm|Pagamento\/Principal/i;
const URL_EMISSAO_CONHECIDA = /tunel|DAMForm|Pagamento\/Principal|ApresentarTFF|ApresentarTLL/i;
const URL_DAM_RENDERIZAVEL = /DAMForm|ApresentarTFF|ApresentarTLL|Pagamento\/Principal/i;

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

function normalizarCotas(tunel: TunelBruto): CotaNormalizada[] {
  return tunel.cotas
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
}

function gerarChaveCota(cota: CotaNormalizada): string {
  const valor = cota.valorCorrigido ?? cota.valorOriginal ?? 0;
  return `${cota.cota.trim().toLowerCase()}|${cota.vencimento.trim()}|${valor}`;
}

function slugArquivoCota(cota: string): string {
  const base = cota
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base === '' ? 'cota' : base;
}

async function contarPorChave(
  pagina: Page,
  cadeias: Record<string, CadeiaSeletores>,
  chave: string,
): Promise<number> {
  const candidatos = cadeias[chave]?.seletores ?? [];
  for (const candidato of candidatos) {
    const total = await pagina.locator(candidato).count().catch(() => 0);
    if (total > 0) {
      return total;
    }
  }
  return 0;
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

type RamoBoleto = 'nova-aba' | 'dam-form' | 'div-pdf';

interface BoletoEmitido {
  numero: number;
  cota: string;
  numeroCota: number | null;
  vencimento: string;
  valor: number | null;
  ramo: RamoBoleto;
  arquivo: string;
}

interface FalhaEmissaoCota {
  cota: string;
  numeroCota: number | null;
  codigo: string;
  motivo: string;
}

interface CotaIgnorada {
  cota: string;
  numeroCota: number | null;
  situacao: 'Quitada';
  tributo: string;
  valorOriginal: number | null;
  valorCorrigido: number | null;
  vencimento: string;
  motivo: string;
}

interface AlvoEmissao {
  indice: number;
  cota: CotaNormalizada;
}

type TunelRecarregado =
  | { estado: 'ok'; cotas: CotaNormalizada[] }
  | { estado: 'sem-divida'; mensagem: string };

function classificarCotas(cotas: CotaNormalizada[]): 'EM_ABERTO' | 'QUITADO' | 'SEM_COTAS' {
  if (cotas.length === 0) {
    return 'SEM_COTAS';
  }
  return cotas.some((c) => c.situacao === 'Em aberto') ? 'EM_ABERTO' : 'QUITADO';
}

function montarDados(
  entrada: DamTffTllParams,
  tunel: TunelBruto,
): {
  dados: Record<string, unknown>;
  situacao: string;
  emAberto: CotaNormalizada[];
  todas: CotaNormalizada[];
  ignoradas: CotaIgnorada[];
} {
  const cotas = normalizarCotas(tunel);
  const situacao = classificarCotas(cotas);
  const emAberto = cotas.filter((c) => c.situacao === 'Em aberto');
  const ignoradas: CotaIgnorada[] = cotas
    .filter((c) => c.situacao !== 'Em aberto')
    .map((c) => ({
      cota: c.cota,
      numeroCota: c.numeroCota,
      situacao: 'Quitada' as const,
      tributo: c.tributo,
      valorOriginal: c.valorOriginal,
      valorCorrigido: c.valorCorrigido,
      vencimento: c.vencimento,
      motivo: 'Quitada — sem boleto a emitir',
    }));
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
  return { dados, situacao, emAberto, todas: cotas, ignoradas };
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
        await this.gerarArtefatos(pagina, ctx, cadeias, entrada);
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
      const montados = montarDados(entrada, tunel);
      const { dados, situacao } = montados;
      const ignoradas: CotaIgnorada[] = [...montados.ignoradas];
      if (montados.emAberto.length > 0) {
        const emissao = await this.emitirBoletos(
          pagina,
          ctx,
          config,
          cadeias,
          entrada,
          montados.emAberto,
          montados.todas,
        );
        dados['boletos'] = emissao.boletos;
        dados['falhas'] = emissao.falhas;
        for (const item of emissao.ignoradas) {
          ignoradas.push(item);
        }
      } else {
        dados['boletos'] = [];
        dados['falhas'] = [];
      }
      dados['ignoradas'] = ignoradas;
      await this.gerarArtefatos(pagina, ctx, cadeias, entrada);
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

  private urlSeguro(pagina: Page): string {
    try {
      return pagina.url();
    } catch {
      return '';
    }
  }

  private condicaoUrlEstavel(pagina: Page): () => boolean {
    let ultima = '';
    let desde = 0;
    return () => {
      const atual = this.urlSeguro(pagina);
      const conhecida = URL_EMISSAO_CONHECIDA.test(atual);
      const agora = Date.now();
      if (!conhecida || atual !== ultima) {
        ultima = atual;
        desde = agora;
        return false;
      }
      return agora - desde >= JANELA_ESTABILIDADE_MS;
    };
  }

  private condicaoTextoPronto(pagina: Page): () => Promise<boolean> {
    return async () => {
      const tamanho = await pagina
        .evaluate(() => (document.body?.innerText ?? '').trim().length)
        .catch(() => 0);
      return tamanho > LIMITE_TEXTO_PRONTO;
    };
  }

  private async esperarCondicao(
    rotulo: string,
    condicao: () => boolean | Promise<boolean>,
    opcoes: { timeoutMs: number; intervaloMs?: number },
  ): Promise<void> {
    const intervalo = opcoes.intervaloMs ?? POLL_CONDICAO_MS;
    const inicio = Date.now();
    for (;;) {
      let pronta = false;
      try {
        pronta = await condicao();
      } catch {
        pronta = false;
      }
      if (pronta) {
        return;
      }
      if (Date.now() - inicio >= opcoes.timeoutMs) {
        throw new Error(`condição não atendida em ${opcoes.timeoutMs}ms`);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, intervalo);
      });
    }
  }

  private async condicaoOuSegue(
    ctx: ExecucaoCtx,
    rotulo: string,
    condicao: () => boolean | Promise<boolean>,
    opcoes: { timeoutMs: number; intervaloMs?: number },
  ): Promise<void> {
    try {
      await this.esperarCondicao(rotulo, condicao, opcoes);
    } catch (erro) {
      this.emitir(
        ctx,
        'warn',
        `Condição ${rotulo} não concluída (${mensagemDeErro(erro)}) — seguindo para a leitura normal.`,
      );
    }
  }

  private chaveConfere(cotas: CotaNormalizada[], alvo: CotaNormalizada): boolean {
    const chave = gerarChaveCota(alvo);
    return cotas.some((c) => gerarChaveCota(c) === chave);
  }

  private localizarCotaVigente(
    cotas: CotaNormalizada[],
    alvo: CotaNormalizada,
    posicao: number,
  ): CotaNormalizada {
    const chave = gerarChaveCota(alvo);
    const exata = cotas.find((c) => gerarChaveCota(c) === chave);
    if (exata !== undefined) {
      return exata;
    }
    const semelhante = cotas.find(
      (c) =>
        c.vencimento === alvo.vencimento &&
        (c.valorCorrigido ?? c.valorOriginal) === (alvo.valorCorrigido ?? alvo.valorOriginal),
    );
    return semelhante ?? cotas[posicao] ?? alvo;
  }

  private ignorarPorSemDivida(alvo: AlvoEmissao): CotaIgnorada {
    return {
      cota: alvo.cota.cota,
      numeroCota: alvo.cota.numeroCota,
      situacao: 'Quitada',
      tributo: alvo.cota.tributo,
      valorOriginal: alvo.cota.valorOriginal,
      valorCorrigido: alvo.cota.valorCorrigido,
      vencimento: alvo.cota.vencimento,
      motivo: 'Quitada na reconsulta — sem dívida no portal',
    };
  }

  private async reaproveitarTunel(pagina: Page, ctx: ExecucaoCtx): Promise<CotaNormalizada[] | null> {
    exigirTempo(ctx.signal, 'reaproveitar-tunel');
    try {
      if (pagina.isClosed()) {
        return null;
      }
      for (const outra of ctx.sessao.context.pages()) {
        if (outra !== pagina) {
          await outra.close().catch(() => undefined);
        }
      }
      const bruto = await pagina.evaluate(extrairTunel).catch(() => null);
      if (bruto === null) {
        return null;
      }
      const cotas = normalizarCotas(bruto);
      if (cotas.length === 0) {
        return null;
      }
      return cotas;
    } catch {
      return null;
    }
  }

  private async sequenciaConsulta(
    pagina: Page,
    ctx: ExecucaoCtx,
    config: PortalConfig,
    cadeias: Record<string, CadeiaSeletores>,
    entrada: DamTffTllParams,
  ): Promise<TunelRecarregado> {
    await this.navegar(pagina, ctx, config);
    await this.preencherCga(pagina, ctx, cadeias, entrada.inscricaoMunicipal);
    await this.selecionarExercicio(pagina, ctx, cadeias, entrada.exercicio);
    await this.resolverCaptcha(pagina, ctx, cadeias);
    const semDivida = await this.submeterConsulta(pagina, ctx, cadeias);
    if (semDivida !== null) {
      return { estado: 'sem-divida', mensagem: semDivida };
    }
    const bruto = await this.extrairDados(pagina, ctx);
    return { estado: 'ok', cotas: normalizarCotas(bruto) };
  }

  private async retornoMinimo(
    pagina: Page,
    ctx: ExecucaoCtx,
    config: PortalConfig,
    cadeias: Record<string, CadeiaSeletores>,
    entrada: DamTffTllParams,
  ): Promise<TunelRecarregado | null> {
    exigirTempo(ctx.signal, 'retorno-minimo');
    this.emitir(ctx, 'log', 'Tentando o retorno mínimo à consulta.');
    try {
      return await this.sequenciaConsulta(pagina, ctx, config, cadeias, entrada);
    } catch {
      return null;
    }
  }

  private async reconsultaCompleta(
    pagina: Page,
    ctx: ExecucaoCtx,
    config: PortalConfig,
    cadeias: Record<string, CadeiaSeletores>,
    entrada: DamTffTllParams,
  ): Promise<TunelRecarregado> {
    exigirTempo(ctx.signal, 'reconsulta-completa');
    this.emitir(ctx, 'log', 'Refazendo a consulta completa.');
    let ultimo: unknown = null;
    for (let tentativa = 1; tentativa <= TENTATIVAS_RECONSULTA; tentativa += 1) {
      try {
        return await this.sequenciaConsulta(pagina, ctx, config, cadeias, entrada);
      } catch (erro) {
        ultimo = erro;
      }
    }
    throw normalizarErro('reconsulta-completa', ultimo);
  }

  private async emitirBoletos(
    pagina: Page,
    ctx: ExecucaoCtx,
    config: PortalConfig,
    cadeias: Record<string, CadeiaSeletores>,
    entrada: DamTffTllParams,
    emAberto: CotaNormalizada[],
    todas: CotaNormalizada[],
  ): Promise<{ boletos: BoletoEmitido[]; falhas: FalhaEmissaoCota[]; ignoradas: CotaIgnorada[] }> {
    const desativado: {
      boletos: BoletoEmitido[];
      falhas: FalhaEmissaoCota[];
      ignoradas: CotaIgnorada[];
    } = { boletos: [], falhas: [], ignoradas: [] };
    if (ctx.artefatos !== 'pdf' && ctx.artefatos !== 'ambos') {
      this.emitir(ctx, 'log', `Emissão de boletos desativada para artefatos ${ctx.artefatos}.`);
      return desativado;
    }
    const temEmissao = await contarPorChave(pagina, cadeias, 'botao_emitir_boleto');
    if (temEmissao === 0) {
      this.emitir(ctx, 'log', 'Portal sem emissão por cota — mantendo a captura inline.');
      return desativado;
    }
    exigirTempo(ctx.signal, 'emitir-boletos');
    this.emitir(ctx, 'log', `Emitindo ${emAberto.length} boleto(s), um por cota em aberto.`);
    const boletos: BoletoEmitido[] = [];
    const falhas: FalhaEmissaoCota[] = [];
    const ignoradas: CotaIgnorada[] = [];
    const alvos: AlvoEmissao[] = emAberto.map((cota, indice) => ({ indice, cota }));
    let vigentes: CotaNormalizada[] = todas;
    for (const [posicao, alvo] of alvos.entries()) {
      try {
        if (posicao > 0) {
          const relidas = await this.reaproveitarTunel(pagina, ctx);
          if (relidas !== null && this.chaveConfere(relidas, alvo.cota)) {
            vigentes = relidas;
            this.emitir(ctx, 'log', `Tela de cotas reaproveitada para a cota ${alvo.cota.cota}.`);
          } else {
            const minimo = await this.retornoMinimo(pagina, ctx, config, cadeias, entrada);
            if (minimo?.estado === 'sem-divida') {
              ignoradas.push(this.ignorarPorSemDivida(alvo));
              continue;
            }
            if (minimo !== null && minimo.estado === 'ok' && this.chaveConfere(minimo.cotas, alvo.cota)) {
              vigentes = minimo.cotas;
            } else {
              const completa = await this.reconsultaCompleta(pagina, ctx, config, cadeias, entrada);
              if (completa.estado === 'sem-divida') {
                ignoradas.push(this.ignorarPorSemDivida(alvo));
                continue;
              }
              vigentes = completa.cotas;
            }
          }
        }
        const atual = this.localizarCotaVigente(vigentes, alvo.cota, alvo.indice);
        if (atual.situacao !== 'Em aberto') {
          ignoradas.push({
            cota: atual.cota,
            numeroCota: alvo.cota.numeroCota,
            situacao: 'Quitada',
            tributo: atual.tributo,
            valorOriginal: atual.valorOriginal,
            valorCorrigido: atual.valorCorrigido,
            vencimento: atual.vencimento,
            motivo: 'Quitada na reconsulta — sem boleto a emitir',
          });
          continue;
        }
        const boleto = await this.emitirBoleto(pagina, ctx, cadeias, entrada, atual, posicao + 1);
        boletos.push(boleto);
        this.emitir(ctx, 'log', `Boleto ${boleto.numero} emitido para a cota ${atual.cota}.`);
      } catch (erro) {
        falhas.push({
          cota: alvo.cota.cota,
          numeroCota: alvo.cota.numeroCota,
          codigo: 'FALHA_BOLETO',
          motivo: mensagemDeErro(erro),
        });
        this.emitir(
          ctx,
          'warn',
          `Falha ao emitir boleto da cota ${alvo.cota.cota}: ${mensagemDeErro(erro)} — seguindo para a próxima cota.`,
        );
      }
    }
    return { boletos, falhas, ignoradas };
  }

  private async selecionarCotaParaEmissao(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
    cota: CotaNormalizada,
  ): Promise<void> {
    exigirTempo(ctx.signal, 'emitir-boleto');
    const campo = await localizarPorChave(pagina, 'campo_cotas', cadeias, 'emitir-boleto');
    const selecionado = await campo
      .evaluate((elemento: unknown, rotulo: string) => {
        const seletor = elemento as unknown as {
          options: ArrayLike<{ text: string; value: string }>;
          selectedIndex: number;
          dispatchEvent(evento: unknown): boolean;
        };
        const criador = (globalThis as unknown as {
          Event: new (tipo: string, init: { bubbles: boolean }) => unknown;
        }).Event;
        const opcoes = Array.from(seletor.options);
        const indice = opcoes.findIndex(
          (opcao) =>
            opcao.text.trim() === rotulo ||
            opcao.text.trim().startsWith(`${rotulo} `) ||
            opcao.text.trim().startsWith(`${rotulo}-`) ||
            opcao.text.trim().startsWith(`${rotulo} -`) ||
            opcao.value === rotulo,
        );
        if (indice < 0) {
          return false;
        }
        seletor.selectedIndex = indice;
        seletor.dispatchEvent(new criador('change', { bubbles: true }));
        return true;
      }, cota.cota)
      .catch(() => false);
    if (!selecionado) {
      throw new EtapaError('emitir-boleto', `Cota ${cota.cota} não encontrada no seletor de cotas.`);
    }
  }

  private existeNovaAbaBoleto(ctx: ExecucaoCtx, anteriores: Set<Page>): boolean {
    return ctx.sessao.context.pages().some((p) => {
      const url = this.urlSeguro(p);
      return url !== '' && !anteriores.has(p) && URL_NOVA_ABA_BOLETO.test(url);
    });
  }

  private async aguardarNovaAbaBoleto(
    ctx: ExecucaoCtx,
    anteriores: Set<Page>,
    numero: number,
  ): Promise<Page | null> {
    try {
      await this.esperarCondicao(
        `aba do boleto ${numero}`,
        () => this.existeNovaAbaBoleto(ctx, anteriores),
        { timeoutMs: TIMEOUT_ABA_MS },
      );
    } catch {
      this.emitir(ctx, 'log', `Sem nova aba para o boleto ${numero} — tentando o embutido na página.`);
      return null;
    }
    const encontrada = ctx.sessao.context.pages().find((p) => {
      const url = this.urlSeguro(p);
      return url !== '' && !anteriores.has(p) && URL_NOVA_ABA_BOLETO.test(url);
    });
    return encontrada ?? null;
  }

  private async emitirBoleto(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
    entrada: DamTffTllParams,
    cota: CotaNormalizada,
    numero: number,
  ): Promise<BoletoEmitido> {
    exigirTempo(ctx.signal, 'emitir-boleto');
    this.emitir(ctx, 'log', `Emitindo o boleto da cota ${cota.cota}.`);
    await this.selecionarCotaParaEmissao(pagina, ctx, cadeias, cota);
    const anteriores = new Set(ctx.sessao.context.pages());
    const botao = await localizarPorChave(pagina, 'botao_emitir_boleto', cadeias, 'emitir-boleto');
    await botao.click();
    await pagina
      .waitForURL(URL_EMISSAO_CONHECIDA, { timeout: TIMEOUT_EMISSAO_NAVEGACAO_MS })
      .catch(() => null);
    await this.condicaoOuSegue(ctx, `tela de emissão do boleto ${numero}`, this.condicaoUrlEstavel(pagina), {
      timeoutMs: TIMEOUT_ESTABILIDADE_MS,
    });
    const url = this.urlSeguro(pagina);
    if (!URL_EMISSAO_CONHECIDA.test(url) || url === '') {
      throw new EtapaError('emitir-boleto', `Tela de emissão indisponível para a cota ${cota.cota}.`);
    }
    if (/DAMForm/i.test(url)) {
      return this.capturarDamForm(pagina, ctx, entrada, cota, numero, url, 'dam-form');
    }
    if (/tunel/i.test(url)) {
      const nova = await this.aguardarNovaAbaBoleto(ctx, anteriores, numero);
      if (nova !== null) {
        try {
          await nova.waitForLoadState('domcontentloaded', { timeout: TIMEOUT_ABA_BOLETO_MS }).catch(() => null);
          await this.condicaoOuSegue(ctx, `conteúdo do boleto ${numero}`, this.condicaoTextoPronto(nova), {
            timeoutMs: TIMEOUT_CONTEUDO_MS,
          });
          const urlNova = this.urlSeguro(nova);
          if (/DAMForm/i.test(urlNova)) {
            return await this.capturarDamForm(nova, ctx, entrada, cota, numero, urlNova, 'nova-aba');
          }
          return await this.capturarViaEmbutido(nova, ctx, cadeias, entrada, cota, numero, urlNova, 'nova-aba');
        } finally {
          if (nova !== pagina) {
            await nova.close().catch(() => undefined);
          }
        }
      }
    }
    return this.capturarViaEmbutido(pagina, ctx, cadeias, entrada, cota, numero, url, 'div-pdf');
  }

  private async lerBoletoEmbutido(
    pagina: Page,
    cadeias: Record<string, CadeiaSeletores>,
  ): Promise<Buffer | null> {
    const candidatos = cadeias['boleto_embutido']?.seletores ?? ['#pdfID'];
    for (const candidato of candidatos) {
      const no = pagina.locator(candidato).first();
      const total = await no.count().catch(() => 0);
      if (total === 0) {
        continue;
      }
      const src = await no
        .getAttribute('src', { timeout: TIMEOUT_RESULTADO_POR_TENTATIVA_MS })
        .catch(() => null);
      if (src === null || !src.includes('base64,')) {
        continue;
      }
      const base64 = src.slice(src.indexOf('base64,') + 7).trim();
      if (base64 === '') {
        continue;
      }
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length === 0) {
        continue;
      }
      return bytes;
    }
    return null;
  }

  private async gravarBoletoPdf(
    ctx: ExecucaoCtx,
    entrada: DamTffTllParams,
    cota: CotaNormalizada,
    numero: number,
    ramo: RamoBoleto,
    pdf: Buffer,
    vencimento: string,
  ): Promise<BoletoEmitido> {
    const diretorio = path.join(
      tmpdir(),
      'api-sefaz-ssa',
      `dam-tff-tll-${entrada.inscricaoMunicipal}-${entrada.exercicio}`,
    );
    await mkdir(diretorio, { recursive: true });
    const arquivo = `boleto-cota-${slugArquivoCota(cota.cota)}.pdf`;
    const caminho = path.join(diretorio, arquivo);
    await writeFile(caminho, pdf);
    ctx.registrarArquivo('boleto', caminho, 'application/pdf');
    return {
      numero,
      cota: cota.cota,
      numeroCota: cota.numeroCota,
      vencimento,
      valor: cota.valorCorrigido ?? cota.valorOriginal,
      ramo,
      arquivo,
    };
  }

  private async capturarDamForm(
    pagina: Page,
    ctx: ExecucaoCtx,
    entrada: DamTffTllParams,
    cota: CotaNormalizada,
    numero: number,
    url: string,
    ramo: RamoBoleto,
  ): Promise<BoletoEmitido> {
    exigirTempo(ctx.signal, 'capturar-boleto');
    const pdf = await pagina.pdf({ format: 'A4', printBackground: true });
    const texto = await pagina
      .evaluate(() => document.body?.innerText ?? '')
      .catch(() => '');
    const vencimento = texto.match(/(\d{2}\/\d{2}\/\d{4})/)?.[1] ?? cota.vencimento;
    if (vencimento === '') {
      throw new EtapaError('capturar-boleto', `Vencimento não encontrado para a cota ${cota.cota}.`);
    }
    return this.gravarBoletoPdf(ctx, entrada, cota, numero, ramo, pdf, vencimento);
  }

  private async capturarViaEmbutido(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
    entrada: DamTffTllParams,
    cota: CotaNormalizada,
    numero: number,
    url: string,
    ramo: RamoBoleto,
  ): Promise<BoletoEmitido> {
    exigirTempo(ctx.signal, 'capturar-boleto');
    this.emitir(ctx, 'log', `Boleto ${numero}: ramo #divPDF (url=${url}).`);
    try {
      await localizarPorChave(pagina, 'sinal_boleto', cadeias, 'aguardar-boleto', ESPERA_SINAL_BOLETO_MS);
    } catch {
      this.emitir(ctx, 'log', `Boleto ${numero}: sinal do boleto ausente — tentando a leitura direta.`);
    }
    await this.condicaoOuSegue(
      ctx,
      `PDF embutido do boleto ${numero}`,
      async () => (await this.lerBoletoEmbutido(pagina, cadeias)) !== null,
      { timeoutMs: TIMEOUT_EMBUTIDO_MS, intervaloMs: POLL_EMBUTIDO_MS },
    );
    try {
      const conteudo = await this.lerBoletoEmbutido(pagina, cadeias);
      if (conteudo === null) {
        throw new EtapaError('capturar-boleto', `PDF embutido não encontrado para a cota ${cota.cota}.`);
      }
      if (cota.vencimento === '') {
        throw new EtapaError('capturar-boleto', `Vencimento não encontrado para a cota ${cota.cota}.`);
      }
      return await this.gravarBoletoPdf(ctx, entrada, cota, numero, ramo, conteudo, cota.vencimento);
    } catch (erro) {
      const atual = this.urlSeguro(pagina);
      if (URL_DAM_RENDERIZAVEL.test(atual)) {
        this.emitir(
          ctx,
          'warn',
          `PDF embutido ausente — capturando a página atual como boleto da cota ${cota.cota}.`,
        );
        return await this.capturarDamForm(pagina, ctx, entrada, cota, numero, atual, 'dam-form');
      }
      throw erro;
    }
  }

  private async gerarArtefatos(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
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
        const boleto = await this.lerBoletoEmbutido(pagina, cadeias);
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
      this.emitir(ctx, 'warn', `Falha ao gerar artefatos: ${mensagemDeErro(erro)} — seguindo sem artefatos.`);
      return;
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
  const brutos: unknown = resultado.dados['boletos'];
  const boletosDados: Array<Record<string, unknown>> = Array.isArray(brutos)
    ? brutos.filter(
        (b): b is Record<string, unknown> => typeof b === 'object' && b !== null,
      )
    : [];
  const porArquivo = new Map(boletosDados.map((b) => [String(b['arquivo'] ?? ''), b]));
  let primeiroBoletoBase64: string | null = null;
  let pdfLegadoBase64: string | null = null;
  for (const arquivo of arquivos) {
    const conteudo = await readFile(arquivo.caminho);
    const base64 = conteudo.toString('base64');
    if (arquivo.tipo === 'print') {
      saida['printBase64'] = base64;
      continue;
    }
    const entrada = porArquivo.get(path.basename(arquivo.caminho));
    if (entrada !== undefined) {
      entrada['pdfBase64'] = base64;
      if (primeiroBoletoBase64 === null) {
        primeiroBoletoBase64 = base64;
      }
    } else {
      pdfLegadoBase64 = base64;
    }
  }
  if (primeiroBoletoBase64 !== null) {
    saida['pdfBase64'] = primeiroBoletoBase64;
  } else if (pdfLegadoBase64 !== null) {
    saida['pdfBase64'] = pdfLegadoBase64;
  }
  return saida;
};

registrarExecutor('dam-tff-tll', executarDamTffTll);
