import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ehTipoAutomacao } from '../../automations/registry.js';
import { WAIT_MAX_SEG } from '../../config/constants.js';
import { env } from '../../config/env.js';
import { db, DocumentosRepository } from '../../database/index.js';
import { artefatosSchema, schemaDoTipo } from '../../modules/automation/automation.schemas.js';
import type {
  ConsultarSincronaInput,
  ExecucaoResposta,
  IniciarExecucaoInput,
} from '../../modules/automation/automation.types.js';
import { obterCanalProgresso, type CanalProgresso } from '../../modules/jobs/progresso.js';
import { ValidationError } from '../../shared/errors/index.js';
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
    ...params
  } = registro;
  const comum = comumSchema.parse({
    artefatos,
    inline,
    forceRefresh,
    async: assincrono,
    idempotencyKey,
  });
  return { params, comum };
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
      const { tipo } = tipoParamsSchema.parse(request.params);
      if (!ehTipoAutomacao(tipo)) {
        throw new ValidationError(`Tipo de automação inválido: ${tipo}`);
      }
      schemaDoTipo(tipo);
      const { params, comum } = separarCorpo(request.body);
      const query = consultaComoRegistro(request.query);
      const espera = esperaDaQuery(query['wait']) ?? (comum.async === false ? WAIT_MAX_SEG : null);
      const entrada: IniciarExecucaoInput = {
        tipo,
        params,
        artefatos: comum.artefatos ?? 'nenhum',
        inline: comum.inline ?? false,
        forceRefresh: comum.forceRefresh ?? false,
        apiKeyId: request.apiKeyId,
        ...(comum.idempotencyKey === undefined ? {} : { idempotencyKey: comum.idempotencyKey }),
      };
      if (espera === null) {
        const resposta = await servico.iniciar(entrada);
        await responderExecucao(reply, resposta, { ...opcoes, inline: entrada.inline });
      } else {
        const resposta = await servico.consultarSincrona({ ...entrada, waitSeg: espera });
        await responderExecucao(reply, resposta, { ...opcoes, inline: entrada.inline });
      }
    } catch (erro) {
      await responderComErro(reply, erro);
    }
  });

  app.get('/v1/execucoes/:id', async (request, reply) => {
    try {
      exigirApiKey(request);
      const { id } = idParamsSchema.parse(request.params);
      await reply.send(await servico.consultar(id, request.apiKeyId));
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
