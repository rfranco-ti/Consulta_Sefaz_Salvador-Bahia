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

export const SEFAZ_BAHIA_SOCIO_TIMEOUT_MS = 90000;

const TIMEOUT_NAVEGACAO_MS = 30000;
const TIMEOUT_RESULTADO_POR_TENTATIVA_MS = 8000;

export const sefazBahiaSocioInputSchema = z.object({
  cpf: z
    .string()
    .transform((valor) => valor.replace(/\D/g, ''))
    .refine((valor) => valor.length === 11, 'CPF inválido: deve conter 11 dígitos'),
});

export type SefazBahiaSocioParams = z.infer<typeof sefazBahiaSocioInputSchema>;

const artefatosEscolhaSchema = z.enum(['nenhum', 'pdf', 'print', 'ambos']);

type ArtefatosEscolha = z.infer<typeof artefatosEscolhaSchema>;

interface ElementoPagina {
  readonly nodeType: number;
  readonly tagName: string;
  readonly textContent: string | null;
  readonly childNodes: ListaNosPagina;
  querySelector(seletor: string): ElementoPagina | null;
  querySelectorAll(seletor: string): ListaNosPagina;
}

interface ListaNosPagina {
  readonly length: number;
  item(indice: number): ElementoPagina | null;
  forEach(acao: (no: ElementoPagina, indice: number) => void): void;
}

interface DocumentoPagina {
  getElementById(id: string): ElementoPagina | null;
  querySelectorAll(seletor: string): ListaNosPagina;
  readonly body: { readonly innerText: string } | null;
}

declare const document: DocumentoPagina;

interface EstabelecimentoBruto {
  cnpj: string;
  inscricaoEstadual: string;
  razaoSocial: string;
  atividadeEconomica: string;
  condicao: string;
  situacao: string;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
  municipio: string;
  uf: string;
  cep: string;
  telefone: string;
  dataSituacao: string;
  dataInicioVigencia: string;
  dataFimVigencia: string;
}

interface SocioBruto {
  nome: string;
  cpfFormatado: string;
  dataConsulta: string;
  textoBruto: string;
  estabelecimentos: EstabelecimentoBruto[];
}

type ArquivoRegistrado = {
  tipo: Parameters<ExecucaoCtx['registrarArquivo']>[0];
  caminho: string;
  contentType: Parameters<ExecucaoCtx['registrarArquivo']>[2];
};

let configPortal: PortalConfig | null = null;

async function obterConfigPortal(): Promise<PortalConfig> {
  if (configPortal === null) {
    configPortal = await carregarPortalConfig('sefaz-bahia-socio');
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

function extrairSocio(): SocioBruto {
  const aplainar = (texto: string): string =>
    texto.replace(/\u00a0/g, ' ').replace(/\s{2,}/g, ' ').trim();

  const extrairPares = (celula: ElementoPagina): Array<{ rotulo: string; valor: string }> => {
    const pares: Array<{ rotulo: string; valor: string }> = [];
    let rotuloAtual: string | null = null;
    let valorAtual = '';
    celula.childNodes.forEach((no) => {
      if (no.nodeType === 1 && no.tagName === 'B') {
        if (rotuloAtual !== null) {
          pares.push({ rotulo: rotuloAtual, valor: aplainar(valorAtual) });
        }
        const texto = aplainar(no.textContent ?? '').replace(/:$/, '');
        rotuloAtual = texto === '' ? null : texto;
        valorAtual = '';
      } else {
        valorAtual += no.textContent ?? '';
      }
    });
    if (rotuloAtual !== null) {
      pares.push({ rotulo: rotuloAtual, valor: aplainar(valorAtual) });
    }
    return pares;
  };

  const tabelaSocio = document.getElementById('TabelaSocio');
  let nome = '';
  let cpfFormatado = '';
  if (tabelaSocio !== null) {
    tabelaSocio.querySelectorAll('td').forEach((celula) => {
      for (const par of extrairPares(celula)) {
        const rotulo = par.rotulo.toLowerCase();
        if (rotulo === 'nome' && nome === '') {
          nome = par.valor;
        }
        if (rotulo === 'cpf' && cpfFormatado === '') {
          cpfFormatado = par.valor;
        }
      }
    });
  }

  const vazio = (): EstabelecimentoBruto => ({
    cnpj: '',
    inscricaoEstadual: '',
    razaoSocial: '',
    atividadeEconomica: '',
    condicao: '',
    situacao: '',
    logradouro: '',
    numero: '',
    complemento: '',
    bairro: '',
    municipio: '',
    uf: '',
    cep: '',
    telefone: '',
    dataSituacao: '',
    dataInicioVigencia: '',
    dataFimVigencia: '',
  });

  const temCampo = (estabelecimento: EstabelecimentoBruto): boolean =>
    Object.values(estabelecimento).some((valor) => valor !== '');

  const aplicarPar = (alvo: EstabelecimentoBruto, rotulo: string, valor: string): void => {
    if (rotulo === 'cnpj') alvo.cnpj = valor;
    else if (rotulo === 'inscrição estadual') alvo.inscricaoEstadual = valor;
    else if (rotulo === 'razão social') alvo.razaoSocial = valor;
    else if (rotulo === 'atividade econômica') alvo.atividadeEconomica = valor;
    else if (rotulo === 'condição') alvo.condicao = valor;
    else if (rotulo === 'situação') alvo.situacao = valor;
    else if (rotulo === 'logradouro') alvo.logradouro = valor;
    else if (rotulo === 'número') alvo.numero = valor;
    else if (rotulo === 'complemento') alvo.complemento = valor;
    else if (rotulo === 'bairro/distrito') alvo.bairro = valor;
    else if (rotulo === 'município') alvo.municipio = valor;
    else if (rotulo === 'uf') alvo.uf = valor;
    else if (rotulo === 'cep') alvo.cep = valor;
    else if (rotulo === 'telefone') alvo.telefone = valor;
    else if (rotulo === 'data da situação') alvo.dataSituacao = valor;
    else if (rotulo === 'data início vigência') alvo.dataInicioVigencia = valor;
    else if (rotulo === 'data fim vigência') alvo.dataFimVigencia = valor;
  };

  const lista: EstabelecimentoBruto[] = [];
  const tabela = document.getElementById('TabelaEstabelecimentos');
  if (tabela !== null) {
    let atual: EstabelecimentoBruto | null = null;
    tabela.querySelectorAll('tr').forEach((linha) => {
      const textoLinha = aplainar(linha.textContent ?? '');
      if (textoLinha === '') {
        if (atual !== null && temCampo(atual)) {
          lista.push(atual);
          atual = null;
        }
        return;
      }
      if (/Estabelecimentos aos quais/i.test(textoLinha) || /Nenhum estabelecimento/i.test(textoLinha)) {
        return;
      }
      let temCnpj = false;
      linha.querySelectorAll('td').forEach((celula) => {
        for (const par of extrairPares(celula)) {
          if (par.rotulo.toLowerCase() === 'cnpj' && par.valor !== '') {
            temCnpj = true;
          }
        }
      });
      if (temCnpj && atual !== null && temCampo(atual)) {
        lista.push(atual);
        atual = null;
      }
      const alvo: EstabelecimentoBruto = atual === null ? vazio() : atual;
      atual = alvo;
      linha.querySelectorAll('td').forEach((celula) => {
        for (const par of extrairPares(celula)) {
          aplicarPar(alvo, par.rotulo.toLowerCase(), par.valor);
        }
      });
    });
    if (atual !== null && temCampo(atual)) {
      lista.push(atual);
    }
  }

  let dataConsulta = '';
  document.querySelectorAll('table').forEach((tabelaGenerica) => {
    if (dataConsulta !== '') {
      return;
    }
    const texto = aplainar(tabelaGenerica.textContent ?? '');
    const achado = /Data da Consulta\s*:\s*([\d/]+)/i.exec(texto);
    if (achado !== null && achado[1] !== undefined) {
      dataConsulta = achado[1];
    }
  });

  return {
    nome,
    cpfFormatado,
    dataConsulta,
    textoBruto: document.body?.innerText ?? '',
    estabelecimentos: lista,
  };
}

function normalizarDados(cpfBuscado: string, brutos: SocioBruto): Record<string, unknown> {
  const formatarCpf = (digitos: string): string =>
    digitos.length === 11
      ? `${digitos.slice(0, 3)}.${digitos.slice(3, 6)}.${digitos.slice(6, 9)}-${digitos.slice(9)}`
      : digitos;

  const formatarCep = (valor: string): string => {
    const digitos = valor.replace(/\D/g, '');
    return digitos.length === 8 ? `${digitos.slice(0, 5)}-${digitos.slice(5)}` : valor;
  };

  const limparVazio = (valor: string): string => (/^[\s()\-–/]+$/.test(valor) ? '' : valor);

  const limparSufixo = (valor: string): string =>
    valor.replace(/\s*ME\s*$/i, '').replace(/\s*EPP\s*$/i, '').trim();

  return {
    cpfBuscado,
    nome: brutos.nome,
    cpf: brutos.cpfFormatado === '' ? formatarCpf(cpfBuscado) : brutos.cpfFormatado,
    totalEstabelecimentos: brutos.estabelecimentos.length,
    estabelecimentos: brutos.estabelecimentos.map((item) => ({
      cnpj: item.cnpj,
      inscricaoEstadual: limparSufixo(item.inscricaoEstadual),
      razaoSocial: item.razaoSocial,
      atividadeEconomica: item.atividadeEconomica,
      condicao: item.condicao,
      situacao: item.situacao.trim(),
      logradouro: item.logradouro,
      numero: item.numero,
      complemento: limparVazio(item.complemento),
      bairro: item.bairro,
      municipio: item.municipio,
      uf: item.uf,
      cep: formatarCep(item.cep),
      telefone: limparVazio(item.telefone),
      dataSituacao: item.dataSituacao,
      dataInicioVigencia: item.dataInicioVigencia,
      dataFimVigencia: limparVazio(item.dataFimVigencia),
    })),
    dataConsulta: brutos.dataConsulta,
    textoBruto: brutos.textoBruto,
  };
}

export class SefazBahiaSocioRobot extends BaseRobot {
  readonly tipo = 'sefaz-bahia-socio';
  readonly nome = 'SEFAZ Bahia — Sócio';
  readonly portal = 'SEFAZ_BA';

  async executar(params: Record<string, unknown>, ctx: ExecucaoCtx): Promise<ResultadoRobot> {
    const entrada = sefazBahiaSocioInputSchema.safeParse(params);
    if (!entrada.success) {
      throw new ValidationError('CPF inválido: deve conter 11 dígitos', entrada.error.flatten());
    }
    const cpf = entrada.data.cpf;
    try {
      const config = await obterConfigPortal();
      const cadeias = extrairCadeias(config);
      const pagina = ctx.sessao.page;
      this.emitir(ctx, 'log', `Iniciando consulta de sócio SEFAZ Bahia para o CPF ${cpf}`);
      await this.navegar(pagina, ctx, config);
      await this.preencherCpf(pagina, ctx, cadeias, cpf);
      await this.submeterConsulta(pagina, ctx, cadeias);
      const brutos = await this.extrairDados(pagina, ctx);
      const dados = normalizarDados(cpf, brutos);
      await this.gerarArtefatos(pagina, ctx, cpf);
      if (brutos.estabelecimentos.length === 0) {
        return {
          sucesso: false,
          dados,
          mensagem: 'Nenhum estabelecimento encontrado para o CPF informado.',
        };
      }
      this.emitir(
        ctx,
        'log',
        `Consulta concluída: ${brutos.estabelecimentos.length} estabelecimento(s) para o CPF ${cpf}`,
      );
      return {
        sucesso: true,
        dados,
        mensagem: 'Consulta de sócio SEFAZ Bahia realizada com sucesso.',
      };
    } catch (erro) {
      this.emitir(ctx, 'error', mensagemDeErro(erro));
      throw erro;
    }
  }

  private async navegar(pagina: Page, ctx: ExecucaoCtx, config: PortalConfig): Promise<void> {
    exigirTempo(ctx.signal, 'navegar-portal');
    this.emitir(ctx, 'log', 'Acessando o portal de sócio da SEFAZ Bahia');
    try {
      await pagina.goto(config.navegacao.url, {
        waitUntil: config.navegacao.waitUntil,
        timeout: TIMEOUT_NAVEGACAO_MS,
      });
    } catch (erro) {
      throw normalizarErro('navegar-portal', erro);
    }
  }

  private async preencherCpf(
    pagina: Page,
    ctx: ExecucaoCtx,
    cadeias: Record<string, CadeiaSeletores>,
    cpf: string,
  ): Promise<void> {
    exigirTempo(ctx.signal, 'preencher-cpf');
    this.emitir(ctx, 'log', 'Preenchendo o CPF para consulta');
    try {
      const campo = await localizarPorChave(pagina, 'campo_cpf', cadeias, 'preencher-cpf');
      await campo.fill('');
      await campo.fill(cpf);
    } catch (erro) {
      throw normalizarErro('preencher-cpf', erro);
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

  private async extrairDados(pagina: Page, ctx: ExecucaoCtx): Promise<SocioBruto> {
    exigirTempo(ctx.signal, 'extrair-dados');
    this.emitir(ctx, 'log', 'Extraindo os dados do sócio e dos estabelecimentos');
    try {
      return await pagina.evaluate(extrairSocio);
    } catch (erro) {
      throw normalizarErro('extrair-dados', erro);
    }
  }

  private async gerarArtefatos(pagina: Page, ctx: ExecucaoCtx, cpf: string): Promise<void> {
    exigirTempo(ctx.signal, 'gerar-artefatos');
    if (ctx.artefatos === 'nenhum') {
      return;
    }
    this.emitir(ctx, 'log', 'Gerando os artefatos da consulta');
    try {
      const diretorio = path.join(tmpdir(), 'api-sefaz-ssa', `sefaz-bahia-socio-${cpf}`);
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

function validarPayload(payload: string): { cpf: string; artefatos: ArtefatosEscolha } {
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
  const entrada = sefazBahiaSocioInputSchema.safeParse(registro);
  if (!entrada.success) {
    throw new ValidationError('CPF inválido: deve conter 11 dígitos', entrada.error.flatten());
  }
  const artefatos = artefatosEscolhaSchema.safeParse(registro['artefatos'] ?? 'nenhum');
  if (!artefatos.success) {
    throw new ValidationError('Opção de artefatos inválida: use nenhum, pdf, print ou ambos');
  }
  return { cpf: entrada.data.cpf, artefatos: artefatos.data };
}

export const executarSefazBahiaSocio = async (
  execucao: Execucao,
  sessao: BrowserSession,
): Promise<ResultadoExecutor> => {
  const { cpf, artefatos } = validarPayload(execucao.payload);
  const canal = obterCanalProgresso();
  const robo = new SefazBahiaSocioRobot();
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
    signal: AbortSignal.timeout(SEFAZ_BAHIA_SOCIO_TIMEOUT_MS),
  };
  const resultado = await robo.executar({ cpf }, ctx);
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

registrarExecutor('sefaz-bahia-socio', executarSefazBahiaSocio);
