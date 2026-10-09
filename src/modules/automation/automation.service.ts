import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { env } from '../../config/env.js';
import { CACHE_VERSION } from '../../config/cache.js';
import { EXECUCOES_ATIVAS_POR_KEY, WAIT_MAX_SEG } from '../../config/constants.js';
import type { TipoAutomacao } from '../../automations/registry.js';
import { db, DocumentosRepository } from '../../database/index.js';
import {
  ConflictError,
  InternalError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
  paraAppError,
} from '../../shared/errors/index.js';
import { logger as loggerPadrao } from '../../shared/logger/index.js';
import {
  CacheConsultas,
  normalizarPayload,
  type LeituraCache,
} from './automation.cache.js';
import {
  AutomationRepository,
  normalizarPayloadArmazenado,
  type ExecucaoRegistro,
} from './automation.repository.js';
import { schemaDoTipo } from './automation.schemas.js';
import type {
  ArtefatosOpcao,
  ConsultarSincronaInput,
  DocumentoInfo,
  ExecucaoResposta,
  IniciarExecucaoInput,
  ResultadoAutomacao,
} from './automation.types.js';
import { obterCanalProgresso, type CanalProgresso } from '../jobs/progresso.js';

export interface OpcoesAutomationService {
  banco: Database.Database;
  repositorio?: AutomationRepository;
  documentos?: DocumentosRepository;
  cache?: CacheConsultas;
  canal?: CanalProgresso;
  gerarId?: (prefixo: 'exe' | 'doc') => string;
  diretorioArmazenamento?: string;
  logger?: Logger;
}

interface VooResolvido {
  resposta: ExecucaoResposta;
  id: string;
  terminal: boolean;
}

interface BlobArtefato {
  tipo: 'print' | 'pdf_pagina';
  contentType: 'image/jpeg' | 'application/pdf';
  extensao: string;
  base64: string;
}

const LIMITE_BLOB_BYTES = 25 * 1024 * 1024;

function gerarIdPadrao(prefixo: 'exe' | 'doc'): string {
  return `${prefixo}_${randomUUID().replace(/-/g, '')}`;
}

function ehRegistro(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function ehTerminal(status: string): boolean {
  return status === 'SUCCESS' || status === 'FAILED' || status === 'CANCELLED';
}

function extrairBlobs(resultado: Record<string, unknown>): BlobArtefato[] {
  const blobs: BlobArtefato[] = [];
  const print = resultado['printBase64'];
  if (typeof print === 'string' && print.length > 0) {
    blobs.push({ tipo: 'print', contentType: 'image/jpeg', extensao: 'jpg', base64: print });
  }
  const pdf = resultado['pdfBase64'];
  if (typeof pdf === 'string' && pdf.length > 0) {
    blobs.push({ tipo: 'pdf_pagina', contentType: 'application/pdf', extensao: 'pdf', base64: pdf });
  }
  return blobs;
}

function nomeSeguro(valor: string): string {
  return valor.replace(/[^a-zA-Z0-9._-]/g, '-');
}

export class AutomationService {
  private readonly repositorio: AutomationRepository;
  private readonly documentos: DocumentosRepository;
  private readonly cache: CacheConsultas;
  private readonly canal: CanalProgresso;
  private readonly gerarId: (prefixo: 'exe' | 'doc') => string;
  private readonly diretorioArmazenamento: string;
  private readonly logger: Logger;

  constructor(opcoes: OpcoesAutomationService) {
    this.repositorio =
      opcoes.repositorio ?? new AutomationRepository(opcoes.banco);
    this.documentos = opcoes.documentos ?? new DocumentosRepository(opcoes.banco);
    this.cache = opcoes.cache ?? new CacheConsultas({ banco: opcoes.banco });
    this.canal = opcoes.canal ?? obterCanalProgresso();
    this.gerarId = opcoes.gerarId ?? gerarIdPadrao;
    this.diretorioArmazenamento = opcoes.diretorioArmazenamento ?? env.STORAGE_DIR;
    this.logger = opcoes.logger ?? loggerPadrao.child({ modulo: 'automation' });
  }

  async iniciar(input: IniciarExecucaoInput): Promise<ExecucaoResposta> {
    return this.obterOuCriar(input).resposta;
  }

  async consultar(id: string, apiKeyId: string): Promise<ExecucaoResposta> {
    const registro = this.repositorio.porId(id);
    const resposta = this.mapearComAcesso(registro, apiKeyId);
    if (resposta.status === 'SUCCESS') {
      this.propagarSucessoParaCache(registro);
    }
    return resposta;
  }

  async cancelar(id: string, apiKeyId: string): Promise<void> {
    const registro = this.repositorio.porId(id);
    if (registro.apiKeyId !== apiKeyId) {
      throw new NotFoundError('Execução não encontrada');
    }
    const final = this.repositorio.cancelar(id);
    this.canal.publicarFinal({
      execucaoId: id,
      status: 'CANCELLED',
      posicaoFila: null,
      tentativa: final.attempts,
    });
  }

  async finalizar(
    execucaoId: string,
    resultado: Record<string, unknown>,
    duracaoMs?: number,
  ): Promise<ExecucaoResposta> {
    const registro = this.repositorio.porId(execucaoId);
    if (ehTerminal(registro.status)) {
      return this.mapear(registro);
    }
    if (registro.status !== 'RUNNING') {
      throw new ConflictError(
        `Execução não pode ser concluída a partir do status ${registro.status}`,
      );
    }
    const sucesso = resultado['sucesso'] === true;
    const dados = resultado['dados'];
    const mensagem = resultado['mensagem'];
    if (!ehRegistro(dados)) {
      await this.falhar(execucaoId, new InternalError('Resultado da automação inválido'));
      throw new InternalError('Resultado da automação inválido');
    }
    const documentos = await this.persistirBlobs(registro, extrairBlobs(resultado));
    const enxuto: Record<string, unknown> = { sucesso, dados };
    if (typeof mensagem === 'string' && mensagem.length > 0) {
      enxuto['mensagem'] = mensagem;
    }
    this.repositorio.marcarSucesso(execucaoId, JSON.stringify(enxuto), duracaoMs);
    if (sucesso) {
      const params = this.paramsArmazenados(registro.payload);
      if (params !== null) {
        this.cache.gravarSucesso(registro.tipo, params, enxuto);
      }
    }
    this.canal.publicarFinal({
      execucaoId,
      status: 'SUCCESS',
      posicaoFila: null,
      tentativa: registro.attempts,
    });
    const resposta = this.mapear(this.repositorio.porId(execucaoId));
    if (documentos.length > 0 && resposta.resultado !== undefined && resposta.resultado !== null) {
      resposta.resultado.documentos = documentos;
    }
    return resposta;
  }

  async falhar(
    execucaoId: string,
    erro: unknown,
    duracaoMs?: number,
  ): Promise<ExecucaoResposta> {
    const registro = this.repositorio.porId(execucaoId);
    if (ehTerminal(registro.status)) {
      return this.mapear(registro);
    }
    if (registro.status !== 'RUNNING') {
      throw new ConflictError(
        `Execução não pode ser marcada como falha a partir do status ${registro.status}`,
      );
    }
    const tipado = paraAppError(erro);
    this.repositorio.marcarFalha(
      execucaoId,
      {
        code: tipado.code,
        message: tipado.message,
        ...(tipado.etapa === undefined ? {} : { etapa: tipado.etapa }),
      },
      duracaoMs,
    );
    this.canal.publicarFinal({
      execucaoId,
      status: 'FAILED',
      posicaoFila: null,
      tentativa: registro.attempts,
    });
    return this.mapear(this.repositorio.porId(execucaoId));
  }

  async consultarSincrona(input: ConsultarSincronaInput): Promise<ExecucaoResposta> {
    const espera = this.validarEspera(input.waitSeg);
    const base = this.obterOuCriar(input);
    if (base.terminal || espera === 0) {
      return base.resposta;
    }
    const concluida = await this.aguardarConclusao(base.id, espera * 1000);
    if (concluida) {
      const registro = this.repositorio.porId(base.id);
      const resposta = this.mapearComAcesso(registro, input.apiKeyId);
      if (resposta.status === 'SUCCESS') {
        this.propagarSucessoParaCache(registro);
      }
      return resposta;
    }
    const atual = this.repositorio.porId(base.id);
    return {
      execucaoId: base.id,
      status: atual.status === 'RUNNING' ? 'RUNNING' : 'PENDING',
      posicaoFila: this.repositorio.posicaoNaFila(base.id),
      cache: { hit: false },
    };
  }

  private obterOuCriar(input: IniciarExecucaoInput): VooResolvido {
    const params = this.validarParams(input.tipo, input.params);
    const artefatos = this.validarArtefatos(input.artefatos);
    const normalizado = normalizarPayload(params);
    if (!input.forceRefresh) {
      const acerto = this.cache.ler(input.tipo, params);
      if (acerto !== null) {
        return this.resolverAcerto(input, params, artefatos, acerto);
      }
    }
    if (input.idempotencyKey !== undefined) {
      this.validarIdempotencia(input.idempotencyKey);
      const existente = this.repositorio.porIdempotencia(input.apiKeyId, input.idempotencyKey);
      if (existente !== null) {
        this.exigirMesmaConsulta(existente, input.tipo, normalizado);
        return {
          resposta: this.mapearComAcesso(existente, input.apiKeyId),
          id: existente.id,
          terminal: ehTerminal(existente.status),
        };
      }
    }
    const voo = this.repositorio.ativaPorParametros(input.tipo, normalizado);
    if (voo !== null) {
      this.repositorio.adicionarParticipante(voo.id, input.apiKeyId);
      this.repositorio.elevarArtefatos(voo.id, artefatos);
      return {
        resposta: this.mapearComAcesso(this.repositorio.porId(voo.id), input.apiKeyId),
        id: voo.id,
        terminal: ehTerminal(voo.status),
      };
    }
    if (this.repositorio.contarAtivasPorChave(input.apiKeyId) >= EXECUCOES_ATIVAS_POR_KEY) {
      throw new RateLimitedError(
        'Limite de execuções simultâneas atingido para esta chave de API',
      );
    }
    const id = this.gerarId('exe');
    try {
      this.repositorio.criar({
        id,
        tipo: input.tipo,
        payload: JSON.stringify({ ...params, artefatos }),
        payloadBruto: JSON.stringify(input.params),
        apiKeyId: input.apiKeyId,
        cacheVersion: CACHE_VERSION,
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      });
    } catch (erro) {
      if (erro instanceof ConflictError && input.idempotencyKey !== undefined) {
        const existente = this.repositorio.porIdempotencia(input.apiKeyId, input.idempotencyKey);
        if (existente !== null) {
          return {
            resposta: this.mapearComAcesso(existente, input.apiKeyId),
            id: existente.id,
            terminal: ehTerminal(existente.status),
          };
        }
      }
      throw erro;
    }
    const posicao = this.repositorio.posicaoNaFila(id);
    this.canal.publicar({ execucaoId: id, status: 'PENDING', posicaoFila: posicao, tentativa: 0 });
    return {
      resposta: { execucaoId: id, status: 'PENDING', posicaoFila: posicao, cache: { hit: false } },
      id,
      terminal: false,
    };
  }

  private resolverAcerto(
    input: IniciarExecucaoInput,
    params: Record<string, unknown>,
    artefatos: ArtefatosOpcao,
    acerto: LeituraCache,
  ): VooResolvido {
    const id = this.gerarId('exe');
    const registro = this.repositorio.criarConcluida(
      {
        id,
        tipo: input.tipo,
        payload: JSON.stringify({ ...params, artefatos }),
        payloadBruto: JSON.stringify(input.params),
        apiKeyId: input.apiKeyId,
        cacheVersion: CACHE_VERSION,
      },
      JSON.stringify(acerto.dados),
    );
    const base = this.mapear(registro);
    return {
      resposta: {
        ...base,
        cache: {
          hit: true,
          camada: acerto.camada,
          ttlRestanteSeg: acerto.ttlRestanteSeg,
        },
      },
      id,
      terminal: true,
    };
  }

  private propagarSucessoParaCache(registro: ExecucaoRegistro): void {
    if (registro.status !== 'SUCCESS') {
      return;
    }
    const params = this.paramsArmazenados(registro.payload);
    if (params === null) {
      return;
    }
    let bruto: unknown;
    try {
      bruto = JSON.parse(registro.resultado ?? '') as unknown;
    } catch {
      return;
    }
    if (!ehRegistro(bruto) || bruto['sucesso'] !== true || !ehRegistro(bruto['dados'])) {
      return;
    }
    const mensagem = bruto['mensagem'];
    const gravavel: Record<string, unknown> = { sucesso: true, dados: bruto['dados'] };
    if (typeof mensagem === 'string' && mensagem.length > 0) {
      gravavel['mensagem'] = mensagem;
    }
    try {
      if (this.cache.ler(registro.tipo, params) !== null) {
        return;
      }
      this.cache.gravarSucesso(registro.tipo, params, gravavel);
    } catch (erro) {
      this.logger.warn({ execucaoId: registro.id, err: erro }, 'Resultado ao vivo fora do cache');
    }
  }

  private exigirMesmaConsulta(
    existente: ExecucaoRegistro,
    tipo: TipoAutomacao,
    normalizado: string,
  ): void {
    if (existente.tipo !== tipo) {
      throw new ConflictError('Chave de idempotência já utilizada para outra consulta');
    }
    if (normalizarPayloadArmazenado(existente.payload) !== normalizado) {
      throw new ConflictError('Chave de idempotência já utilizada para outra consulta');
    }
  }

  private validarParams(tipo: TipoAutomacao, params: unknown): Record<string, unknown> {
    const saida = schemaDoTipo(tipo).safeParse(params);
    if (!saida.success) {
      throw new ValidationError(
        `Parâmetros inválidos para a automação "${tipo}"`,
        saida.error.flatten(),
      );
    }
    const dados: unknown = saida.data;
    if (!ehRegistro(dados)) {
      throw new ValidationError(`Parâmetros inválidos para a automação "${tipo}"`);
    }
    return dados;
  }

  private validarArtefatos(valor: unknown): ArtefatosOpcao {
    if (valor === 'nenhum' || valor === 'pdf' || valor === 'print' || valor === 'ambos') {
      return valor;
    }
    throw new ValidationError('Opção de artefatos inválida: use nenhum, pdf, print ou ambos');
  }

  private validarIdempotencia(chave: string): void {
    if (chave.length < 8 || chave.length > 128) {
      throw new ValidationError('Chave de idempotência inválida: use de 8 a 128 caracteres');
    }
  }

  private validarEspera(waitSeg: number): number {
    if (typeof waitSeg !== 'number' || !Number.isFinite(waitSeg) || waitSeg < 0 || waitSeg > WAIT_MAX_SEG) {
      throw new ValidationError('Tempo de espera inválido: use de 0 a 60 segundos');
    }
    return waitSeg;
  }

  private paramsArmazenados(payload: string): Record<string, unknown> | null {
    try {
      const bruto: unknown = JSON.parse(payload) as unknown;
      if (!ehRegistro(bruto)) {
        return null;
      }
      const copia = { ...bruto };
      delete copia['artefatos'];
      return copia;
    } catch {
      return null;
    }
  }

  private async persistirBlobs(
    registro: ExecucaoRegistro,
    blobs: BlobArtefato[],
  ): Promise<DocumentoInfo[]> {
    const infos: DocumentoInfo[] = [];
    for (const blob of blobs) {
      const info = await this.persistirBlob(registro, blob);
      if (info !== null) {
        infos.push(info);
      }
    }
    return infos;
  }

  private async persistirBlob(
    registro: ExecucaoRegistro,
    blob: BlobArtefato,
  ): Promise<DocumentoInfo | null> {
    try {
      const conteudo = Buffer.from(blob.base64, 'base64');
      if (conteudo.length === 0 || conteudo.length > LIMITE_BLOB_BYTES) {
        throw new InternalError('Artefato da execução inválido');
      }
      const nome = nomeSeguro(`${registro.tipo}-${registro.id}.${blob.extensao}`);
      await mkdir(join(this.diretorioArmazenamento, registro.id), { recursive: true });
      await writeFile(join(this.diretorioArmazenamento, registro.id, nome), conteudo);
      const documento = this.documentos.inserir({
        id: this.gerarId('doc'),
        execucaoId: registro.id,
        apiKeyId: registro.apiKeyId,
        tipo: blob.tipo,
        caminho: `${registro.id}/${nome}`,
        contentType: blob.contentType,
        nomeArquivo: nome,
        tamanhoBytes: conteudo.length,
      });
      return {
        id: documento.id,
        tipo: documento.tipo,
        nome: documento.nomeArquivo,
        contentType: documento.contentType,
        tamanhoBytes: documento.tamanhoBytes,
        url: `/v1/documentos/${documento.id}`,
      };
    } catch (erro) {
      this.logger.warn({ execucaoId: registro.id, err: erro }, 'Artefato da execução descartado');
      return null;
    }
  }

  private aguardarConclusao(id: string, waitMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let concluido = false;
      let desobservar: () => void = () => undefined;
      let temporizador: ReturnType<typeof setTimeout> | undefined;
      const encerrar = (valor: boolean): void => {
        if (concluido) {
          return;
        }
        concluido = true;
        if (temporizador !== undefined) {
          clearTimeout(temporizador);
        }
        desobservar();
        resolve(valor);
      };
      temporizador = setTimeout(() => encerrar(false), waitMs);
      if (typeof temporizador.unref === 'function') {
        temporizador.unref();
      }
      desobservar = this.canal.observar(id, (evento) => {
        if (ehTerminal(evento.status)) {
          encerrar(true);
        }
      });
      if (ehTerminal(this.repositorio.porId(id).status)) {
        encerrar(true);
      }
    });
  }

  private mapearComAcesso(registro: ExecucaoRegistro, apiKeyId: string): ExecucaoResposta {
    if (registro.apiKeyId !== apiKeyId && !this.repositorio.participantes(registro.id).includes(apiKeyId)) {
      throw new NotFoundError('Execução não encontrada');
    }
    return this.mapear(registro);
  }

  private mapear(registro: ExecucaoRegistro): ExecucaoResposta {
    if (registro.status === 'PENDING') {
      return {
        execucaoId: registro.id,
        status: 'PENDING',
        posicaoFila: this.repositorio.posicaoNaFila(registro.id),
        cache: { hit: false },
      };
    }
    if (registro.status === 'RUNNING') {
      return { execucaoId: registro.id, status: 'RUNNING', posicaoFila: null };
    }
    if (registro.status === 'SUCCESS') {
      return {
        execucaoId: registro.id,
        status: 'SUCCESS',
        resultado: this.mapearResultado(registro),
        cache: { hit: false },
        ...(registro.duracaoMs === null ? {} : { duracaoMs: registro.duracaoMs }),
      };
    }
    if (registro.status === 'FAILED') {
      return {
        execucaoId: registro.id,
        status: 'FAILED',
        error: this.mapearErro(registro),
        ...(registro.duracaoMs === null ? {} : { duracaoMs: registro.duracaoMs }),
      };
    }
    return { execucaoId: registro.id, status: 'CANCELLED' };
  }

  private mapearResultado(registro: ExecucaoRegistro): ResultadoAutomacao {
    let bruto: unknown;
    try {
      bruto = JSON.parse(registro.resultado ?? '') as unknown;
    } catch {
      throw new InternalError('Resultado da execução inválido');
    }
    if (!ehRegistro(bruto) || typeof bruto['sucesso'] !== 'boolean' || !ehRegistro(bruto['dados'])) {
      throw new InternalError('Resultado da execução inválido');
    }
    const mensagem = bruto['mensagem'];
    return {
      sucesso: bruto['sucesso'],
      dados: bruto['dados'],
      documentos: this.documentos.listarPorExecucao(registro.id).map((documento) => ({
        id: documento.id,
        tipo: documento.tipo,
        nome: documento.nomeArquivo,
        contentType: documento.contentType,
        tamanhoBytes: documento.tamanhoBytes,
        url: `/v1/documentos/${documento.id}`,
      })),
      ...(typeof mensagem === 'string' && mensagem.length > 0 ? { mensagem } : {}),
    };
  }

  private mapearErro(registro: ExecucaoRegistro): { code: string; message: string; etapa?: string } {
    let bruto: unknown;
    try {
      bruto = JSON.parse(registro.erro ?? '') as unknown;
    } catch {
      throw new InternalError('Erro da execução inválido');
    }
    if (!ehRegistro(bruto) || typeof bruto['code'] !== 'string' || typeof bruto['message'] !== 'string') {
      throw new InternalError('Erro da execução inválido');
    }
    const etapa = bruto['etapa'];
    return {
      code: bruto['code'],
      message: bruto['message'],
      ...(typeof etapa === 'string' && etapa.length > 0 ? { etapa } : {}),
    };
  }
}

export function criarAutomationService(
  parcial: Partial<OpcoesAutomationService> = {},
): AutomationService {
  const banco = parcial.banco ?? db();
  return new AutomationService({ banco, ...parcial });
}
