import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Locator, Page } from 'playwright-core';
import { z } from 'zod';
import { BaseRobot, type ExecucaoCtx, type ResultadoRobot } from '../../base/base-robot.js';
import { TIMEOUT_SELETOR_MS, localizarPorChave, type CadeiaSeletores } from '../../base/seletores.js';
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

export const SEFAZ_BAHIA_TIMEOUT_MS = 90000;

const TIMEOUT_NAVEGACAO_MS = 30000;
const TIMEOUT_RESULTADO_POR_TENTATIVA_MS = 8000;

export const sefazBahiaInputSchema = z.object({
  cnpj: z
    .string()
    .transform((valor) => valor.replace(/\D/g, ''))
    .refine((valor) => valor.length === 14, 'CNPJ inválido: deve conter 14 dígitos'),
});

export type SefazBahiaParams = z.infer<typeof sefazBahiaInputSchema>;

const artefatosEscolhaSchema = z.enum(['nenhum', 'pdf', 'print', 'ambos']);

type ArtefatosEscolha = z.infer<typeof artefatosEscolhaSchema>;

interface ElementoPagina {
  readonly textContent: string | null;
  querySelector(seletor: string): ElementoPagina | null;
  querySelectorAll(seletor: string): ListaNosPagina;
  cloneNode(profundo: boolean): ElementoPagina;
  remove(): void;
}

interface ListaNosPagina {
  readonly length: number;
  item(indice: number): ElementoPagina | null;
  forEach(acao: (no: ElementoPagina, indice: number) => void): void;
}

interface DocumentoPagina {
  getElementById(id: string): ElementoPagina | null;
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
    configPortal = await carregarPortalConfig('sefaz-bahia');
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

function extrairCadastro(): Record<string, string> {
  const aplainar = (texto: string): string =>
    texto.replace(/\u00a0/g, ' ').replace(/\s{2,}/g, ' ').trim();

  const valorCelula = (celula: ElementoPagina): string => {
    const copia = celula.cloneNode(true);
    copia.querySelectorAll('b').forEach((rotulo) => rotulo.remove());
    return aplainar(copia.textContent ?? '');
  };

  const mapearTabela = (id: string): Record<string, string> => {
    const mapa: Record<string, string> = {};
    const tabela = document.getElementById(id);
    if (tabela === null) {
      return mapa;
    }
    tabela.querySelectorAll('td').forEach((celula) => {
      const rotulo = celula.querySelector('b');
      if (rotulo === null) {
        return;
      }
      const chave = aplainar(rotulo.textContent ?? '').replace(/:$/, '');
      if (chave === '') {
        return;
      }
      const valor = valorCelula(celula);
      if (valor !== '') {
        mapa[chave] = valor;
      }
    });
    return mapa;
  };

  const mapearTodasTabelas = (): Record<string, string> => {
    const mapa: Record<string, string> = {};
    const inv = document.getElementById('Table5');
    if (inv === null) {
      return mapa;
    }
    inv.querySelectorAll('td').forEach((celula) => {
      const rotulo = celula.querySelector('b');
      if (rotulo === null) {
        return;
      }
      const chave = aplainar(rotulo.textContent ?? '').replace(/:$/, '');
      if (chave === '' || mapa[chave] !== undefined) {
        return;
      }
      const valor = valorCelula(celula);
      if (valor !== '') {
        mapa[chave] = valor;
      }
    });
    return mapa;
  };

  const obterAtividade = (): string => {
    const tabela = document.getElementById('Table7');
    if (tabela === null) {
      return '';
    }
    let encontrada = '';
    tabela.querySelectorAll('td').forEach((celula) => {
      if (encontrada !== '' || celula.querySelector('b') !== null) {
        return;
      }
      const texto = aplainar(celula.textContent ?? '');
      if (/^\d{7}\s*-\s*\S/.test(texto)) {
        encontrada = texto;
      }
    });
    return encontrada;
  };

  const obterFormaAtuacao = (): string => {
    const tabela = document.getElementById('Table7');
    if (tabela === null) {
      return '';
    }
    const linhas = tabela.querySelectorAll('tr');
    for (let i = 0; i < linhas.length; i += 1) {
      const atual = linhas.item(i);
      if (atual === null) {
        continue;
      }
      if (aplainar(atual.textContent ?? '') === 'Forma de Atuação') {
        const proxima = linhas.item(i + 1);
        return aplainar(proxima?.textContent ?? '').replace(/^[\s\-–]+/, '');
      }
    }
    return '';
  };

  const limparVazio = (valor: string): string => (/^[\s()\-–/]+$/.test(valor) ? '' : valor);

  const formatarCep = (valor: string): string => {
    const digitos = valor.replace(/\D/g, '');
    return digitos.length === 8 ? `${digitos.slice(0, 5)}-${digitos.slice(5)}` : valor;
  };

  const geral = mapearTodasTabelas();
  const info = mapearTabela('Table7');
  const corresp = mapearTabela('Table18');
  const contador = mapearTabela('Table11');
  const consulta = mapearTabela('Table13');

  return {
    cnpj: geral['CNPJ'] ?? '',
    inscricaoEstadual: geral['Inscrição Estadual'] ?? '',
    razaoSocial: geral['Razão Social'] ?? '',
    nomeFantasia: geral['Nome Fantasia'] ?? '',
    naturezaJuridica: geral['Natureza Jurídica'] ?? '',
    unidadeAtendimento: geral['Unidade de Atendimento'] ?? '',
    unidadeFiscalizacao: geral['Unidade de Fiscalização'] ?? '',
    logradouro: geral['Logradouro'] ?? '',
    numero: geral['Número'] ?? '',
    complemento: limparVazio(geral['Complemento'] ?? ''),
    bairro: geral['Bairro/Distrito'] ?? geral['Bairro'] ?? '',
    cep: formatarCep(geral['CEP'] ?? ''),
    municipio: geral['Município'] ?? '',
    uf: geral['UF'] ?? '',
    telefone: limparVazio(geral['Telefone'] ?? ''),
    email: limparVazio(geral['E-mail'] ?? ''),
    referencia: geral['Referência'] ?? '',
    localizacao: geral['Localização'] ?? '',
    dataInclusao: info['Data de Inclusão do Contribuinte'] ?? geral['Data de Inclusão do Contribuinte'] ?? '',
    atividadeEconomica: obterAtividade(),
    formaAtuacao: obterFormaAtuacao(),
    unidade: info['Unidade'] ?? '',
    condicao: info['Condição'] ?? geral['Condição'] ?? '',
    formaPagamento: info['Forma de pagamento'] ?? '',
    situacaoCadastral: info['Situação Cadastral Vigente'] ?? '',
    dataSituacaoCadastral: info['Data desta Situação Cadastral'] ?? '',
    motivoSituacaoCadastral: info['Motivo desta Situação Cadastral'] ?? '',
    dataConsulta: consulta['Data da Consulta'] ?? '',
    logradouroCorresp: corresp['Endereço'] ?? '',
    complementoCorresp: limparVazio(corresp['Complemento'] ?? ''),
    referenciaCorresp: corresp['Referência'] ?? '',
    numeroCorresp: corresp['Número'] ?? '',
    bairroCorresp: corresp['Bairro'] ?? '',
    cepCorresp: formatarCep(corresp['CEP'] ?? ''),
    municipioCorresp: corresp['Município'] ?? '',
    ufCorresp: corresp['UF'] ?? '',
    contadorClassificacaoCrc: contador['Classificação CRC'] ?? '',
    contadorCrc: contador['CRC'] ?? '',
    contadorTipoCrc: contador['Tipo CRC'] ?? '',
    contadorNome: contador['Nome'] ?? '',
    endContadorLogradouro: contador['Endereço'] ?? '',
    endContadorNumero: contador['Número'] ?? '',
    endContadorBairro: contador['Bairro'] ?? '',
    endContadorMunicipio: contador['Município'] ?? '',
    endContadorUf: contador['UF'] ?? '',
    endContadorReferencia: contador['Referencia'] ?? '',
    endContadorCep: formatarCep(contador['CEP'] ?? ''),
    endContadorTelefone: limparVazio(contador['Telefone'] ?? ''),
    endContadorCelular: limparVazio(contador['Celular'] ?? ''),
    endContadorFax: limparVazio(contador['Fax'] ?? ''),
    endContadorEmail: limparVazio(contador['E-mail'] ?? ''),
    textoBruto: document.body?.innerText ?? '',
  };
}

function normalizarDados(cnpjBuscado: string, brutos: Record<string, string>): Record<string, string> {
  const obter = (chave: string): string => brutos[chave] ?? '';
  const estadual = obter('inscricaoEstadual').replace(/\s*\/?ME\s*$/i, '').trim();
  return {
    cnpjBuscado,
    inscricaoEstadual: estadual,
    razaoSocial: obter('razaoSocial'),
    nomeFantasia: obter('nomeFantasia'),
    naturezaJuridica: obter('naturezaJuridica'),
    unidadeAtendimento: obter('unidadeAtendimento'),
    unidadeFiscalizacao: obter('unidadeFiscalizacao'),
    logradouro: obter('logradouro'),
    numero: obter('numero'),
    complemento: obter('complemento'),
    bairro: obter('bairro'),
    cep: obter('cep'),
    municipio: obter('municipio'),
    uf: obter('uf'),
    telefone: obter('telefone'),
    email: obter('email'),
    referencia: obter('referencia'),
    localizacao: obter('localizacao'),
    dataInclusao: obter('dataInclusao'),
    atividadeEconomica: obter('atividadeEconomica'),
    formaAtuacao: obter('formaAtuacao'),
    unidade: obter('unidade'),
    condicao: obter('condicao'),
    formaPagamento: obter('formaPagamento'),
    situacaoCadastral: obter('situacaoCadastral').trim(),
    dataSituacaoCadastral: obter('dataSituacaoCadastral'),
    motivoSituacaoCadastral: obter('motivoSituacaoCadastral'),
    dataConsulta: obter('dataConsulta'),
    logradouroCorresp: obter('logradouroCorresp'),
    complementoCorresp: obter('complementoCorresp'),
    referenciaCorresp: obter('referenciaCorresp'),
    numeroCorresp: obter('numeroCorresp'),
    bairroCorresp: obter('bairroCorresp'),
    cepCorresp: obter('cepCorresp'),
    municipioCorresp: obter('municipioCorresp'),
    ufCorresp: obter('ufCorresp'),
    contadorClassificacaoCrc: obter('contadorClassificacaoCrc'),
    contadorCrc: obter('contadorCrc'),
    contadorTipoCrc: obter('contadorTipoCrc'),
    contadorNome: obter('contadorNome'),
    endContadorLogradouro: obter('endContadorLogradouro'),
    endContadorNumero: obter('endContadorNumero'),
    endContadorBairro: obter('endContadorBairro'),
    endContadorMunicipio: obter('endContadorMunicipio'),
    endContadorUf: obter('endContadorUf'),
    endContadorReferencia: obter('endContadorReferencia'),
    endContadorCep: obter('endContadorCep'),
    endContadorTelefone: obter('endContadorTelefone'),
    endContadorCelular: obter('endContadorCelular'),
    endContadorFax: obter('endContadorFax'),
    endContadorEmail: obter('endContadorEmail'),
  };
}

export class SefazBahiaRobot extends BaseRobot {
  readonly tipo = 'sefaz-bahia';
  readonly nome = 'SEFAZ Bahia';
  readonly portal = 'SEFAZ_BA';

  async executar(params: Record<string, unknown>, ctx: ExecucaoCtx): Promise<ResultadoRobot> {
    const entrada = sefazBahiaInputSchema.safeParse(params);
    if (!entrada.success) {
      throw new ValidationError('CNPJ inválido: deve conter 14 dígitos', entrada.error.flatten());
    }
    const cnpj = entrada.data.cnpj;
    try {
      const config = await obterConfigPortal();
      const cadeias = extrairCadeias(config);
      const pagina = ctx.sessao.page;
      this.emitir(ctx, 'log', `Iniciando consulta SEFAZ Bahia para o CNPJ ${cnpj}`);
      await this.navegar(pagina, ctx, config);
      await this.preencherCnpj(pagina, ctx, cadeias, cnpj);
      await this.submeterConsulta(pagina, ctx, cadeias);
      const brutos = await this.extrairDados(pagina, ctx);
      const dados = normalizarDados(cnpj, brutos);
      await this.gerarArtefatos(pagina, ctx, cnpj);
      if (dados['inscricaoEstadual'] === '') {
        return {
          sucesso: false,
          dados: { cnpjBuscado: cnpj },
          mensagem: 'Inscrição Estadual não encontrada para o CNPJ informado.',
        };
      }
      this.emitir(
        ctx,
        'log',
        `Consulta concluída: Estadual ${dados['inscricaoEstadual']} | Situação ${dados['situacaoCadastral']}`,
      );
      return {
        sucesso: true,
        dados,
        mensagem: 'Consulta SEFAZ Bahia realizada com sucesso.',
      };
    } catch (erro) {
      this.emitir(ctx, 'error', mensagemDeErro(erro));
      throw erro;
    }
  }

  private async navegar(pagina: Page, ctx: ExecucaoCtx, config: PortalConfig): Promise<void> {
    exigirTempo(ctx.signal, 'navegar-portal');
    this.emitir(ctx, 'log', 'Acessando o portal da SEFAZ Bahia');
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
        'tabela_resultado',
        cadeias,
        'aguardar-resultado',
        TIMEOUT_RESULTADO_POR_TENTATIVA_MS,
      );
    } catch (erro) {
      throw normalizarErro('aguardar-resultado', erro);
    }
  }

  private async extrairDados(pagina: Page, ctx: ExecucaoCtx): Promise<Record<string, string>> {
    exigirTempo(ctx.signal, 'extrair-dados');
    this.emitir(ctx, 'log', 'Extraindo os dados do cadastro');
    try {
      return await pagina.evaluate(extrairCadastro);
    } catch (erro) {
      throw normalizarErro('extrair-dados', erro);
    }
  }

  private async gerarArtefatos(pagina: Page, ctx: ExecucaoCtx, cnpj: string): Promise<void> {
    exigirTempo(ctx.signal, 'gerar-artefatos');
    if (ctx.artefatos === 'nenhum') {
      return;
    }
    this.emitir(ctx, 'log', 'Gerando os artefatos da consulta');
    try {
      const diretorio = path.join(tmpdir(), 'api-sefaz-ssa', `sefaz-bahia-${cnpj}`);
      await mkdir(diretorio, { recursive: true });
      if (ctx.artefatos === 'print' || ctx.artefatos === 'ambos') {
        const print = await pagina.screenshot({ type: 'jpeg', quality: 70, fullPage: true });
        const caminhoPrint = path.join(diretorio, 'print.jpg');
        await writeFile(caminhoPrint, print);
        ctx.registrarArquivo('print', caminhoPrint, 'image/jpeg');
      }
      if (ctx.artefatos === 'pdf' || ctx.artefatos === 'ambos') {
        const pdf = await pagina.pdf({ format: 'A4', printBackground: true });
        const caminhoPdf = path.join(diretorio, 'pagina.pdf');
        await writeFile(caminhoPdf, pdf);
        ctx.registrarArquivo('pdf_pagina', caminhoPdf, 'application/pdf');
      }
    } catch (erro) {
      throw normalizarErro('gerar-artefatos', erro);
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
  const entrada = sefazBahiaInputSchema.safeParse(registro);
  if (!entrada.success) {
    throw new ValidationError('CNPJ inválido: deve conter 14 dígitos', entrada.error.flatten());
  }
  const artefatos = artefatosEscolhaSchema.safeParse(registro['artefatos'] ?? 'nenhum');
  if (!artefatos.success) {
    throw new ValidationError('Opção de artefatos inválida: use nenhum, pdf, print ou ambos');
  }
  return { cnpj: entrada.data.cnpj, artefatos: artefatos.data };
}

export const executarSefazBahia = async (
  execucao: Execucao,
  sessao: BrowserSession,
): Promise<ResultadoExecutor> => {
  const { cnpj, artefatos } = validarPayload(execucao.payload);
  const canal = obterCanalProgresso();
  const robo = new SefazBahiaRobot();
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
    signal: AbortSignal.timeout(SEFAZ_BAHIA_TIMEOUT_MS),
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
    if (arquivo.tipo === 'pdf_pagina') {
      saida['pdfBase64'] = conteudo.toString('base64');
    }
  }
  return saida;
};

registrarExecutor('sefaz-bahia', executarSefazBahia);
