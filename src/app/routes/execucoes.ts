import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ehTipoAutomacao, tipoPorSlug, type TipoAutomacao } from '../../automations/registry.js';
import { WAIT_MAX_SEG } from '../../config/constants.js';
import { env } from '../../config/env.js';
import { db, DocumentosRepository } from '../../database/index.js';
import { artefatosSchema, schemaDoTipo } from '../../modules/automation/automation.schemas.js';
import { unirArtefatos } from '../../modules/automation/automation.repository.js';
import type {
  ArquivoSolicitado,
  ArtefatosOpcao,
  ConsultarSincronaInput,
  DocumentoInfo,
  ExecucaoResposta,
  IniciarExecucaoInput,
} from '../../modules/automation/automation.types.js';
import { obterCanalProgresso, type CanalProgresso } from '../../modules/jobs/progresso.js';
import { AppError, NotFoundError, ValidationError } from '../../shared/errors/index.js';
import { exigirApiKey, responderComErro } from '../erros.js';
import { lerDoArmazenamento, type LeitorArquivo } from './documentos.js';

export interface ServicoExecucoes {
  iniciar(input: IniciarExecucaoInput): Promise<ExecucaoResposta>;
  consultarSincrona(input: ConsultarSincronaInput): Promise<ExecucaoResposta>;
  consultar(id: string, apiKeyId: string): Promise<ExecucaoResposta>;
  cancelar(id: string, apiKeyId: string): Promise<void>;
}

export interface DepsExecucoes {
  servico: ServicoExecucoes;
  documentos?: DocumentosRepository;
  diretorioArmazenamento?: string;
  lerArquivo?: LeitorArquivo;
}

export interface DepsProgresso {
  servico: Pick<ServicoExecucoes, 'consultar'>;
  canal?: CanalProgresso;
  intervaloKeepAliveMs?: number;
}

export interface OpcoesResposta {
  inline: boolean;
  documentos?: DocumentosRepository;
  diretorioArmazenamento?: string;
  lerArquivo?: LeitorArquivo;
}

const INTERVALO_KEEP_ALIVE_MS = 15_000;

const tipoParamsSchema = z.object({
  tipo: z.string({ error: 'Tipo de automação é obrigatório' }).trim().min(1, {
    error: 'Tipo de automação é obrigatório',
  }),
});

const idParamsSchema = z.object({
  id: z
    .string({ error: 'Identificador é obrigatório' })
    .trim()
    .min(1, { error: 'Identificador é obrigatório' }),
});

/**
 * Aceita o slug público (ex.: `ficha-cadastral-resumida`) ou o id interno
 * (ex.: `ficha-cadastral`), como `GET /v1/:slug`. O retorno é sempre o id
 * interno — é ele que alimenta `IniciarExecucaoInput.tipo` (chave de cache,
 * despacho do robô, TTL e nome de documento dependem dele).
 */
function resolverTipo(parametro: string): TipoAutomacao {
  const viaSlug = tipoPorSlug(parametro);
  if (viaSlug) return viaSlug;
  if (ehTipoAutomacao(parametro)) return parametro;
  throw new ValidationError(`Tipo de automação inválido: ${parametro}`);
}

const comumSchema = z.object({
  artefatos: artefatosSchema.optional(),
  inline: z.boolean({ error: 'inline deve ser verdadeiro ou falso' }).optional(),
  forceRefresh: z.boolean({ error: 'forceRefresh deve ser verdadeiro ou falso' }).optional(),
  async: z.boolean({ error: 'async deve ser verdadeiro ou falso' }).optional(),
  idempotencyKey: z
    .string({ error: 'Chave de idempotência deve ser um texto' })
    .min(8, { error: 'Chave de idempotência inválida: use de 8 a 128 caracteres' })
    .max(128, { error: 'Chave de idempotência inválida: use de 8 a 128 caracteres' })
    .optional(),
});

function consultaComoRegistro(query: unknown): Record<string, unknown> {
  if (typeof query !== 'object' || query === null) {
    return {};
  }
  return query as Record<string, unknown>;
}

export function esperaDaQuery(valor: unknown): number | undefined {
  if (valor === undefined) {
    return undefined;
  }
  if (typeof valor === 'number') {
    return valor;
  }
  if (typeof valor === 'string') {
    if (valor.trim() === '') {
      return undefined;
    }
    const numero = Number(valor);
    if (Number.isNaN(numero)) {
      throw new ValidationError('Tempo de espera inválido: use de 0 a 60 segundos');
    }
    return numero;
  }
  throw new ValidationError('Tempo de espera inválido: use de 0 a 60 segundos');
}

function separarCorpo(body: unknown): {
  params: Record<string, unknown>;
  comum: z.infer<typeof comumSchema>;
  file: ArquivoSolicitado | null;
  fileNoCorpo: boolean;
  /** Verdadeiro quando o corpo trouxe `artefatos: 'nenhum'` explicitamente. */
  artefatosNenhumExplicito: boolean;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('Corpo da requisição deve ser um objeto JSON');
  }
  const registro = body as Record<string, unknown>;
  const {
    artefatos,
    inline,
    forceRefresh,
    async: assincrono,
    idempotencyKey,
    file: fileBruto,
    ...params
  } = registro;
  const comum = comumSchema.parse({
    artefatos,
    inline,
    forceRefresh,
    async: assincrono,
    idempotencyKey,
  });
  const fileNoCorpo = Object.hasOwn(registro, 'file');
  return {
    params,
    comum,
    file: interpretarFile(fileBruto),
    fileNoCorpo,
    artefatosNenhumExplicito: registro['artefatos'] === 'nenhum',
  };
}

/**
 * Parâmetro de controle `file` (opt-in de download binário do artefato).
 *
 * Valores aceitos — qualquer outro valor responde 400 VALIDATION_ERROR:
 * - ausente ou `false` → resposta JSON inalterada (padrão, sem arquivo);
 * - `true` → artefato primário: o primeiro `application/pdf`, senão o
 *   primeiro `image/jpeg`;
 * - `pdf` → o primeiro documento `application/pdf`;
 * - `print` → o primeiro documento `image/jpeg`.
 *
 * É chave de CONTROLE: nunca compõe o payload do robô nem a chave de cache.
 * Aceita booleanos nativos (corpo JSON) e strings sem sensibilidade a caixa.
 */
export function interpretarFile(valor: unknown): ArquivoSolicitado | null {
  if (valor === undefined || valor === null) {
    return null;
  }
  if (typeof valor === 'boolean') {
    return valor ? 'principal' : null;
  }
  if (typeof valor === 'string') {
    const normalizado = valor.trim().toLowerCase();
    if (normalizado === 'false') {
      return null;
    }
    if (normalizado === 'true') {
      return 'principal';
    }
    if (normalizado === 'pdf') {
      return 'pdf';
    }
    if (normalizado === 'print') {
      return 'print';
    }
  }
  throw new ValidationError('Parâmetro file inválido: use true, false, pdf ou print');
}

/**
 * Eleva a opção de artefatos para o mínimo exigido pelo `file` solicitado,
 * reutilizando `unirArtefatos` (o mesmo mecanismo de elevação do
 * single-flight). `file=pdf` ⇒ ao menos `pdf`; `file=print` ⇒ ao menos
 * `print`; `file=true` ⇒ `ambos`.
 */
export function artefatosParaArquivo(
  atuais: ArtefatosOpcao,
  file: ArquivoSolicitado | null,
): ArtefatosOpcao {
  if (file === null) {
    return atuais;
  }
  if (file === 'pdf') {
    return unirArtefatos(atuais, 'pdf');
  }
  if (file === 'print') {
    return unirArtefatos(atuais, 'print');
  }
  return unirArtefatos(atuais, 'ambos');
}

export function selecionarDocumento(
  documentos: DocumentoInfo[] | undefined,
  pedido: ArquivoSolicitado,
): DocumentoInfo | undefined {
  const lista = documentos ?? [];
  if (pedido === 'pdf') {
    return lista.find((item) => item.contentType === 'application/pdf');
  }
  if (pedido === 'print') {
    return lista.find((item) => item.contentType === 'image/jpeg');
  }
  return (
    lista.find((item) => item.contentType === 'application/pdf') ??
    lista.find((item) => item.contentType === 'image/jpeg')
  );
}

/**
 * Regra do cache em primeiro lugar para `file`: prioridade do cache é
 * absoluta, MAS se `file` foi explicitamente pedido e a entrada em cache não
 * tem nenhum artefato utilizável para ele (lista sem correspondência), isso
 * conta como miss PARA ESTE pedido — o chamador deve executar de novo com
 * `forceRefresh` e artefatos elevados, em vez de prender o cliente num 410.
 * Referências que existiam mas estão ilegíveis/expiradas NÃO caem aqui: viram
 * 410 em `responderArquivo`.
 */
export function precisaRenovarParaArquivo(
  resposta: ExecucaoResposta,
  file: ArquivoSolicitado | null,
): boolean {
  if (file === null || resposta.status !== 'SUCCESS' || resposta.cache?.hit !== true) {
    return false;
  }
  return selecionarDocumento(resposta.resultado?.documentos, file) === undefined;
}

function erroArquivoExpirado(documentoId: string, execucaoId: string): AppError {
  return new AppError('ARQUIVO_EXPIRADO', 'Artefato expirado ou removido do armazenamento', 410, {
    details: {
      documentoId,
      execucaoId,
      hint: 'Repita a consulta com forceRefresh=true para gerar um novo artefato',
    },
  });
}

/**
 * Responde com os bytes brutos do documento: Content-Type do documento,
 * Content-Disposition attachment (mesma lógica de /v1/documentos/:id) e os
 * metadados do envelope JSON preservados em headers, já que o envelope é
 * substituído pelo binário.
 */
export async function responderArquivo(
  reply: FastifyReply,
  resposta: ExecucaoResposta,
  documento: DocumentoInfo,
  opcoes: OpcoesResposta,
): Promise<void> {
  const repositorio = opcoes.documentos ?? new DocumentosRepository(db());
  const registro = repositorio.buscarPorId(documento.id);
  const agora = new Date().toISOString();
  if (registro === null || (registro.expiraEm !== null && registro.expiraEm <= agora)) {
    throw erroArquivoExpirado(documento.id, resposta.execucaoId);
  }
  const ler =
    opcoes.lerArquivo ??
    ((caminho: string) =>
      lerDoArmazenamento(opcoes.diretorioArmazenamento ?? env.STORAGE_DIR, caminho));
  let bytes: Buffer;
  try {
    bytes = await ler(registro.caminho);
  } catch (erro) {
    if (erro instanceof NotFoundError) {
      throw erroArquivoExpirado(documento.id, resposta.execucaoId);
    }
    throw erro;
  }
  const cache = resposta.cache;
  void reply
    .header('content-type', registro.contentType)
    .header('content-disposition', `attachment; filename="${registro.nomeArquivo}"`)
    .header('x-execucao-id', resposta.execucaoId)
    .header('x-cache-hit', cache?.hit === true ? 'true' : 'false');
  if (cache?.camada !== undefined) {
    void reply.header('x-cache-camada', cache.camada);
  }
  if (cache?.ttlRestanteSeg !== undefined) {
    void reply.header('x-cache-ttl-restante-seg', String(cache.ttlRestanteSeg));
  }
  await reply.send(bytes);
}

export async function responderExecucaoComArquivo(
  reply: FastifyReply,
  resposta: ExecucaoResposta,
  opcoes: OpcoesResposta & { file: ArquivoSolicitado | null },
): Promise<void> {
  const { file, ...base } = opcoes;
  if (file === null || resposta.status !== 'SUCCESS') {
    await responderExecucao(reply, resposta, base);
    return;
  }
  try {
    const alvo = selecionarDocumento(resposta.resultado?.documentos, file);
    if (alvo === undefined) {
      throw new AppError(
        'NOT_FOUND',
        'Nenhum artefato disponível para download nesta execução',
        404,
        {
          details: {
            file,
            execucaoId: resposta.execucaoId,
            hint: 'Solicite a consulta com file=pdf, file=print ou file=true e artefatos compatíveis para gerar o arquivo',
          },
        },
      );
    }
    await responderArquivo(reply, resposta, alvo, base);
  } catch (erro) {
    await responderComErro(reply, erro);
  }
}

export function statusDaFalha(codigo: string): number {
  switch (codigo) {
    case 'VALIDATION_ERROR':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'EXTERNAL_SERVICE_ERROR':
      return 502;
    case 'FILA_CHEIA':
    case 'PORTAL_INDISPONIVEL':
      return 503;
    case 'TIMEOUT':
      return 504;
    default:
      return 500;
  }
}

function ehTerminal(status: string): boolean {
  return status === 'SUCCESS' || status === 'FAILED' || status === 'CANCELLED';
}

async function anexarInline(
  resposta: ExecucaoResposta,
  opcoes: OpcoesResposta,
): Promise<{ pdfBase64?: string; printBase64?: string }> {
  if (!opcoes.inline) {
    return {};
  }
  const itens = resposta.resultado?.documentos ?? [];
  if (itens.length === 0) {
    return {};
  }
  const repositorio = opcoes.documentos ?? new DocumentosRepository(db());
  const ler =
    opcoes.lerArquivo ??
    ((caminho: string) =>
      lerDoArmazenamento(opcoes.diretorioArmazenamento ?? env.STORAGE_DIR, caminho));
  const extras: { pdfBase64?: string; printBase64?: string } = {};
  for (const item of itens) {
    const registro = repositorio.buscarPorId(item.id);
    if (registro === null) {
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await ler(registro.caminho);
    } catch {
      continue;
    }
    if (registro.contentType === 'application/pdf' && extras.pdfBase64 === undefined) {
      extras.pdfBase64 = bytes.toString('base64');
    }
    if (registro.contentType === 'image/jpeg' && extras.printBase64 === undefined) {
      extras.printBase64 = bytes.toString('base64');
    }
  }
  return extras;
}

export async function responderExecucao(
  reply: FastifyReply,
  resposta: ExecucaoResposta,
  opcoes: OpcoesResposta,
): Promise<void> {
  if (resposta.status === 'PENDING' || resposta.status === 'RUNNING') {
    await reply.code(202).send({
      execucaoId: resposta.execucaoId,
      status: resposta.status,
      posicaoFila: resposta.posicaoFila ?? null,
      cache: resposta.cache ?? { hit: false },
    });
    return;
  }
  if (resposta.status === 'SUCCESS') {
    const extras = await anexarInline(resposta, opcoes);
    const resultado = resposta.resultado;
    await reply.code(200).send({
      execucaoId: resposta.execucaoId,
      status: 'SUCCESS',
      sucesso: resultado?.sucesso ?? true,
      dados: resultado?.dados ?? {},
      ...(resultado?.mensagem === undefined ? {} : { mensagem: resultado.mensagem }),
      ...(resultado?.avisos === undefined ? {} : { avisos: resultado.avisos }),
      documentos: resultado?.documentos ?? [],
      cache: resposta.cache ?? { hit: false },
      ...(resposta.duracaoMs === undefined ? {} : { duracaoMs: resposta.duracaoMs }),
      ...extras,
    });
    return;
  }
  if (resposta.status === 'FAILED') {
    const codigo = resposta.error?.code ?? 'AUTOMACAO_ERROR';
    const mensagem = resposta.error?.message ?? 'Automação falhou';
    await reply.code(statusDaFalha(codigo)).send({ error: { code: codigo, message: mensagem } });
    return;
  }
  await reply.code(200).send({ execucaoId: resposta.execucaoId, status: 'CANCELLED' });
}

export function registrarExecucoes(app: FastifyInstance, deps: DepsExecucoes): void {
  const servico = deps.servico;
  const opcoes: OpcoesResposta = {
    inline: false,
    documentos: deps.documentos,
    diretorioArmazenamento: deps.diretorioArmazenamento,
    lerArquivo: deps.lerArquivo,
  };

  app.post('/v1/automacoes/:tipo', async (request, reply) => {
    try {
      exigirApiKey(request);
      const { tipo: parametro } = tipoParamsSchema.parse(request.params);
      const tipo = resolverTipo(parametro);
      schemaDoTipo(tipo);
      const { params, comum, file: fileCorpo, fileNoCorpo, artefatosNenhumExplicito } =
        separarCorpo(request.body);
      const query = consultaComoRegistro(request.query);
      const file = fileNoCorpo ? fileCorpo : interpretarFile(query['file']);
      if (file !== null && artefatosNenhumExplicito) {
        throw new ValidationError(
          'Parâmetros conflitantes: artefatos=nenhum não gera artefatos, mas file solicita o arquivo; ajuste artefatos ou remova file',
        );
      }
      const espera = esperaDaQuery(query['wait']) ?? (comum.async === false ? WAIT_MAX_SEG : null);
      const entrada: IniciarExecucaoInput = {
        tipo,
        params,
        artefatos: artefatosParaArquivo(comum.artefatos ?? 'nenhum', file),
        inline: comum.inline ?? false,
        forceRefresh: comum.forceRefresh ?? false,
        apiKeyId: request.apiKeyId,
        ...(comum.idempotencyKey === undefined ? {} : { idempotencyKey: comum.idempotencyKey }),
      };
      const opcoesArquivo = {
        ...opcoes,
        inline: entrada.inline,
        file,
      };
      if (espera === null) {
        let resposta = await servico.iniciar(entrada);
        if (precisaRenovarParaArquivo(resposta, file)) {
          resposta = await servico.iniciar({
            ...entrada,
            forceRefresh: true,
            artefatos: artefatosParaArquivo(entrada.artefatos, file),
          });
        }
        await responderExecucaoComArquivo(reply, resposta, opcoesArquivo);
      } else {
        let resposta = await servico.consultarSincrona({ ...entrada, waitSeg: espera });
        if (precisaRenovarParaArquivo(resposta, file)) {
          resposta = await servico.consultarSincrona({
            ...entrada,
            forceRefresh: true,
            artefatos: artefatosParaArquivo(entrada.artefatos, file),
            waitSeg: espera,
          });
        }
        await responderExecucaoComArquivo(reply, resposta, opcoesArquivo);
      }
    } catch (erro) {
      await responderComErro(reply, erro);
    }
  });

  app.get('/v1/execucoes/:id', async (request, reply) => {
    try {
      exigirApiKey(request);
      const { id } = idParamsSchema.parse(request.params);
      const query = consultaComoRegistro(request.query);
      const file = interpretarFile(query['file']);
      const resposta = await servico.consultar(id, request.apiKeyId);
      // Divergência documentada: sem `file` (ou fora de SUCCESS) esta rota
      // preserva o shape bruto do serviço em vez do envelope de
      // `responderExecucao`. Com `file` + SUCCESS, serve o binário (ou
      // 404/410) via o mesmo helper das demais rotas; nunca JSON silencioso.
      if (file === null || resposta.status !== 'SUCCESS') {
        await reply.send(resposta);
        return;
      }
      await responderExecucaoComArquivo(reply, resposta, {
        file,
        inline: false,
        documentos: deps.documentos,
        diretorioArmazenamento: deps.diretorioArmazenamento,
        lerArquivo: deps.lerArquivo,
      });
    } catch (erro) {
      await responderComErro(reply, erro);
    }
  });

  app.delete('/v1/execucoes/:id', async (request, reply) => {
    try {
      exigirApiKey(request);
      const { id } = idParamsSchema.parse(request.params);
      await servico.cancelar(id, request.apiKeyId);
      await reply.send({ execucaoId: id, status: 'CANCELLED' });
    } catch (erro) {
      await responderComErro(reply, erro);
    }
  });

  app.get('/v1/execucoes/:id/documentos', async (request, reply) => {
    try {
      exigirApiKey(request);
      const { id } = idParamsSchema.parse(request.params);
      const resposta = await servico.consultar(id, request.apiKeyId);
      await reply.send({ execucaoId: id, documentos: resposta.resultado?.documentos ?? [] });
    } catch (erro) {
      await responderComErro(reply, erro);
    }
  });
}

export function registrarProgresso(app: FastifyInstance, deps: DepsProgresso): void {
  const servico = deps.servico;
  const intervaloMs = deps.intervaloKeepAliveMs ?? INTERVALO_KEEP_ALIVE_MS;

  app.get('/v1/execucoes/:id/progresso', async (request, reply) => {
    let atual: ExecucaoResposta;
    try {
      exigirApiKey(request);
      const params = idParamsSchema.parse(request.params);
      atual = await servico.consultar(params.id, request.apiKeyId);
    } catch (erro) {
      await responderComErro(reply, erro);
      return;
    }
    const canal = deps.canal ?? obterCanalProgresso();
    const execucaoId = atual.execucaoId;
    const chave = request.apiKeyId;
    reply.hijack();
    const saida = reply.raw;
    saida.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let encerrado = false;
    let desobservar: () => void = () => undefined;
    const enviar = (evento: string, dados: unknown): void => {
      if (!encerrado) {
        saida.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);
      }
    };
    const emitirTerminal = (fim: ExecucaoResposta): void => {
      if (fim.status === 'FAILED') {
        enviar('erro', {
          code: fim.error?.code ?? 'AUTOMACAO_ERROR',
          mensagem: fim.error?.message ?? 'Automação falhou',
        });
      } else {
        enviar('done', { status: fim.status, execucaoId: fim.execucaoId });
      }
    };
    const finalizarPeloCanal = async (): Promise<void> => {
      try {
        emitirTerminal(await servico.consultar(execucaoId, chave));
      } catch {
        enviar('erro', { code: 'INTERNAL_ERROR', mensagem: 'Erro interno' });
      } finally {
        encerrar();
      }
    };
    const keepAlive = setInterval(() => {
      if (!encerrado) {
        saida.write(': ping\n\n');
      }
    }, intervaloMs);
    keepAlive.unref();
    const encerrar = (): void => {
      if (encerrado) {
        return;
      }
      encerrado = true;
      clearInterval(keepAlive);
      desobservar();
      saida.end();
    };
    request.raw.on('close', () => {
      encerrado = true;
      clearInterval(keepAlive);
      desobservar();
    });
    if (ehTerminal(atual.status)) {
      emitirTerminal(atual);
      encerrar();
      return;
    }
    enviar('status', { status: atual.status });
    desobservar = canal.observar(execucaoId, (evento) => {
      if (ehTerminal(evento.status)) {
        void finalizarPeloCanal();
        return;
      }
      if (evento.etapa !== undefined) {
        enviar('etapa', {
          nivel: 'log',
          mensagem: evento.etapa,
          em: new Date().toISOString(),
        });
      }
      enviar('status', { status: evento.status });
    });
  });
}
