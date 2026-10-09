import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { env } from '../../config/env.js';
import { CACHE_VERSION, cacheConfig } from '../../config/cache.js';
import { EXECUCOES_ATIVAS_POR_KEY, WAIT_MAX_SEG } from '../../config/constants.js';
import type { TipoAutomacao } from '../../automations/registry.js';
import { db, DocumentosRepository, type Documento } from '../../database/index.js';
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
  agora?: () => number;
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

/**
 * Artefatos solicitados na execução, lidos do payload armazenado
 * (`{ ...params, artefatos }`). Devolve `null` quando o payload não traz
 * uma opção válida — nesse caso nenhuma advertência é sintetizada.
 */
function lerArtefatosSolicitados(payload: string): ArtefatosOpcao | null {
  try {
    const bruto: unknown = JSON.parse(payload) as unknown;
    if (!ehRegistro(bruto)) {
      return null;
    }
    const valor = bruto['artefatos'];
    if (valor === 'nenhum' || valor === 'pdf' || valor === 'print' || valor === 'ambos') {
      return valor;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Mensagem factual exibida ao usuário final quando artefatos foram
 * solicitados mas nenhum documento foi persistido. Os nomes derivam do que
 * foi efetivamente pedido: `pdf` → "(pdf)", `print` → "(print)",
 * `ambos` → "(pdf, print)". Devolve `null` para `nenhum`.
 */
function avisoArtefatosAusentes(artefatos: ArtefatosOpcao): string | null {
  if (artefatos === 'nenhum') {
    return null;
  }
  const nomes = artefatos === 'ambos' ? 'pdf, print' : artefatos;
  return `Artefatos solicitados (${nomes}) não foram gerados nesta execução.`;
}

function ehAvisosValidos(valor: unknown): valor is string[] {
  return (
    Array.isArray(valor) &&
    valor.length > 0 &&
    valor.every((item) => typeof item === 'string' && item.length > 0)
  );
}

/**
 * Metadados de documento carregados no cache. Nunca contém bytes do arquivo:
 * apenas referências resolvidas contra a tabela `documentos` no momento do
 * acerto, descartando referências cujas linhas expiraram/foram removidas.
 */
export interface DocumentoReferencia {
  id: string;
  tipo: string;
  nome: string;
  contentType: string;
  tamanhoBytes: number;
  url: string;
  execucaoId: string;
}

function paraDocumentoInfo(documento: Documento): DocumentoInfo {
  return {
    id: documento.id,
    tipo: documento.tipo,
    nome: documento.nomeArquivo,
    contentType: documento.contentType,
    tamanhoBytes: documento.tamanhoBytes,
    url: `/v1/documentos/${documento.id}`,
  };
}

function paraReferencia(documento: Documento): DocumentoReferencia {
  return { ...paraDocumentoInfo(documento), execucaoId: documento.execucaoId };
}

function extrairReferencias(valor: unknown): DocumentoReferencia[] | null {
  if (!ehRegistro(valor)) {
    return null;
  }
  const lista = valor['documentos'];
  if (lista === undefined) {
    return null;
  }
  if (!Array.isArray(lista)) {
    return null;
  }
  const refs: DocumentoReferencia[] = [];
  for (const item of lista) {
    if (!ehRegistro(item)) {
      return null;
    }
    const { id, tipo, nome, contentType, tamanhoBytes, url, execucaoId } = item as Record<
      string,
      unknown
    >;
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof execucaoId !== 'string' ||
      execucaoId.length === 0
    ) {
      return null;
    }
    refs.push({
      id,
      tipo: typeof tipo === 'string' ? tipo : '',
      nome: typeof nome === 'string' ? nome : '',
      contentType: typeof contentType === 'string' ? contentType : '',
      tamanhoBytes: typeof tamanhoBytes === 'number' ? tamanhoBytes : 0,
      url: typeof url === 'string' ? url : `/v1/documentos/${id}`,
      execucaoId,
    });
  }
  return refs;
}

export class AutomationService {
  private readonly repositorio: AutomationRepository;
  private readonly documentos: DocumentosRepository;
  private readonly cache: CacheConsultas;
  private readonly canal: CanalProgresso;
  private readonly gerarId: (prefixo: 'exe' | 'doc') => string;
  private readonly diretorioArmazenamento: string;
  private readonly logger: Logger;
  private readonly agora: () => number;

  constructor(opcoes: OpcoesAutomationService) {
    this.repositorio =
      opcoes.repositorio ?? new AutomationRepository(opcoes.banco);
    this.documentos = opcoes.documentos ?? new DocumentosRepository(opcoes.banco);
    this.cache = opcoes.cache ?? new CacheConsultas({ banco: opcoes.banco });
    this.canal = opcoes.canal ?? obterCanalProgresso();
    this.gerarId = opcoes.gerarId ?? gerarIdPadrao;
    this.diretorioArmazenamento = opcoes.diretorioArmazenamento ?? env.STORAGE_DIR;
    this.logger = opcoes.logger ?? loggerPadrao.child({ modulo: 'automation' });
    this.agora = opcoes.agora ?? Date.now;
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
    // Instante único de expiração: documentos e cache expiram juntos, de modo
    // que um PDF nunca expire antes da entrada de cache que o produziu.
    const expiraEm = new Date(this.agora() + cacheConfig(registro.tipo).ttlMs).toISOString();
    const documentos = await this.persistirBlobs(registro, extrairBlobs(resultado), expiraEm);
    const enxuto: Record<string, unknown> = { sucesso, dados };
    if (typeof mensagem === 'string' && mensagem.length > 0) {
      enxuto['mensagem'] = mensagem;
    }
    // Advertência sintetizada no serviço — o único lugar com o quadro
    // completo (resultado + artefatos pedidos + documentos persistidos).
    // Condição: execução com `sucesso === true`, artefatos pedidos
    // (`artefatos !== 'nenhum'` no payload armazenado) e ZERO documentos
    // persistidos. Vale para todos os robôs, mesmo os que não emitem o
    // warn de progresso. Execuções FAILED nunca recebem aviso (o erro já
    // explica) e `sucesso === false` também não (achado negativo do portal).
    if (sucesso && documentos.length === 0) {
      const solicitados = lerArtefatosSolicitados(registro.payload);
      if (solicitados !== null) {
        const aviso = avisoArtefatosAusentes(solicitados);
        if (aviso !== null) {
          enxuto['avisos'] = [aviso];
        }
      }
    }
    this.repositorio.marcarSucesso(execucaoId, JSON.stringify(enxuto), duracaoMs);
    if (sucesso) {
      const params = this.paramsArmazenados(registro.payload);
      if (params !== null) {
        // Decisão de cache: `enxuto` (incluindo `avisos` quando presente) é
        // gravado integralmente, de modo que o acerto de cache volta a
        // expor a advertência a cada hit até o TTL expirar. É honesto — a
        // entrada cacheada continua sem artefatos — ainda que possa parecer
        // repetitivo; a alternativa (omitir do cache) reintroduziria a
        // falha silenciosa justamente no caminho mais usado. Ver
        // `propagarSucessoParaCache`, que copia `avisos` do resultado
        // armazenado pelo mesmo critério para não divergir deste bloco.
        this.cache.gravarSucesso(
          registro.tipo,
          params,
          {
            ...enxuto,
            ...(documentos.length === 0
              ? {}
              : {
                  documentos: documentos.map((info) => ({
                    ...info,
                    execucaoId: registro.id,
                  })),
                }),
          },
          expiraEm,
        );
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
    // forceRefresh pula a leitura SEM invalidar a entrada anterior: o novo
    // voo substitui a entrada via `finalizar` → `gravarSucesso`
    // (INSERT OR REPLACE) somente ao concluir com sucesso. Se o voo forçado
    // FALHAR, `falhar` nunca toca no cache e a entrada anterior continua
    // servindo os demais clientes (sem perda de disponibilidade). Falhas
    // nunca são cacheadas. A junção ao voo em andamento abaixo é mantida de
    // propósito: evita uma segunda ida ao portal para os mesmos parâmetros.
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
    // O cache é global entre chaves de API, mas o download exige participação
    // na execução (routes/documentos). Concede participação à chave
    // solicitante na execução sintética e em cada execução originadora dos
    // documentos referenciados, reutilizando o mecanismo existente
    // `execucoes_participantes` — nenhum mecanismo novo foi inventado.
    this.repositorio.adicionarParticipante(id, input.apiKeyId);
    const refs = extrairReferencias(acerto.dados);
    if (refs !== null) {
      const origens = new Set(refs.map((ref) => ref.execucaoId));
      for (const origem of origens) {
        try {
          this.repositorio.adicionarParticipante(origem, input.apiKeyId);
        } catch (erro) {
          this.logger.warn(
            { execucaoId: id, origem, err: erro },
            'Participação na execução originadora do cache ignorada',
          );
        }
      }
    }
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
    const ttlMs = cacheConfig(registro.tipo).ttlMs;
    const finalizadoMs = Date.parse(registro.finalizadoEm ?? '');
    // Age-gate: sondar uma execução antiga não pode ressuscitar o cache com
    // TTL cheio (staleness ilimitada). Além disso o cache nunca pode
    // sobreviver aos documentos que referencia, então grava com a expiração
    // ORIGINAL (finalizadoEm + TTL), nunca `agora + TTL`.
    if (!Number.isFinite(finalizadoMs) || finalizadoMs + ttlMs <= this.agora()) {
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
    // Consistência com `finalizar`: copia `avisos` do resultado armazenado
    // pelo mesmo critério, para que a repopulação do cache via sondagem
    // (`consultar`/`consultarSincrona` em execução antiga) produza o mesmo
    // payload que a gravação original. Sem isto, sondar uma execução sem
    // artefatos ressuscitaria o cache SEM a advertência, divergindo de
    // `finalizar` e reintroduzindo a falha silenciosa no acerto seguinte.
    const avisosArmazenados = bruto['avisos'];
    if (ehAvisosValidos(avisosArmazenados)) {
      gravavel['avisos'] = [...avisosArmazenados];
    }
    const referenciaveis = this.documentos.listarPorExecucao(registro.id);
    if (referenciaveis.length > 0) {
      gravavel['documentos'] = referenciaveis.map(paraReferencia);
    }
    try {
      if (this.cache.ler(registro.tipo, params) !== null) {
        return;
      }
      this.cache.gravarSucesso(
        registro.tipo,
        params,
        gravavel,
        new Date(finalizadoMs + ttlMs).toISOString(),
      );
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
    expiraEm: string,
  ): Promise<DocumentoInfo[]> {
    const infos: DocumentoInfo[] = [];
    for (const blob of blobs) {
      const info = await this.persistirBlob(registro, blob, expiraEm);
      if (info !== null) {
        infos.push(info);
      }
    }
    return infos;
  }

  private async persistirBlob(
    registro: ExecucaoRegistro,
    blob: BlobArtefato,
    expiraEm: string,
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
        expiraEm,
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
    const avisosBrutos = bruto['avisos'];
    // A advertência só é exposta quando a execução atual pediu artefatos:
    // um acerto de cache com `artefatos: 'nenhum'` sobre uma entrada
    // artefato-less suprime o aviso herdado (nada foi pedido, nada falta).
    // O payload sintético do acerto carrega os artefatos do NOVO pedido, de
    // modo que a filtragem pelo payload atual preserva o invariante
    // `nenhum` ⇒ sem aviso em todos os caminhos, sem perder o aviso quando
    // os artefatos foram de fato solicitados.
    const solicitados = lerArtefatosSolicitados(registro.payload);
    const exporAvisos =
      solicitados !== null && solicitados !== 'nenhum' && ehAvisosValidos(avisosBrutos);
    return {
      sucesso: bruto['sucesso'],
      dados: bruto['dados'],
      documentos: this.resolverDocumentosResultado(bruto, registro.id),
      ...(typeof mensagem === 'string' && mensagem.length > 0 ? { mensagem } : {}),
      ...(exporAvisos ? { avisos: [...(avisosBrutos as string[])] } : {}),
    };
  }

  /**
   * Resolve os documentos do resultado. Quando o resultado armazenado carrega
   * referências de documentos vindas do cache (execuções sintéticas de acerto),
   * resolve cada referência contra as linhas vivas via `listarPorIds`,
   * descartando referências expiradas/removidas para nunca emitir URL que
   * responde 404. Caso contrário, lista os documentos da própria execução.
   */
  private resolverDocumentosResultado(
    bruto: Record<string, unknown>,
    execucaoId: string,
  ): DocumentoInfo[] {
    const refs = extrairReferencias(bruto);
    if (refs === null) {
      return this.documentos.listarPorExecucao(execucaoId).map(paraDocumentoInfo);
    }
    if (refs.length === 0) {
      return [];
    }
    const agora = new Date().toISOString();
    return this.documentos
      .listarPorIds(refs.map((ref) => ref.id))
      .filter((documento) => documento.expiraEm === null || documento.expiraEm > agora)
      .map(paraDocumentoInfo);
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
