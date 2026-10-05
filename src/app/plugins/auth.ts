import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import { db } from '../../database/client.js';
import {
  ApiKeysRepository,
  type ApiKey,
} from '../../database/repositories/api-keys.repository.js';
import {
  ForbiddenError,
  RateLimitedError,
  UnauthorizedError,
  type AppError,
} from '../../shared/errors/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyId: string;
  }
}

export interface OpcoesAutenticacao {
  repositorio: ApiKeysRepository;
  agora: () => number;
  limitePorMinuto: number;
}

interface UsoJanela {
  inicio: number;
  total: number;
}

const JANELA_MS = 60_000;

export function registrarAutenticacao(
  app: FastifyInstance,
  parcial?: Partial<OpcoesAutenticacao>,
): void {
  const repositorio = parcial?.repositorio ?? new ApiKeysRepository(db());
  const agora = parcial?.agora ?? Date.now;
  const limitePorMinuto = parcial?.limitePorMinuto ?? env.RATE_LIMIT_POR_MINUTO;
  const usos = new Map<string, UsoJanela>();

  app.decorateRequest('apiKeyId', '');
  app.addHook('onRequest', async (request, reply) => {
    const caminho = extrairCaminho(request);
    if (!ehRotaProtegida(caminho)) {
      return;
    }
    const apresentada = extrairChaveApresentada(request);
    if (apresentada === null) {
      await responderComErro(reply, new UnauthorizedError());
      return;
    }
    const chave = localizarPorHash(repositorio.listar(), gerarHash(apresentada));
    if (chave === null) {
      await responderComErro(reply, new UnauthorizedError());
      return;
    }
    if (!chave.ativa) {
      await responderComErro(reply, new ForbiddenError('Chave de API revogada'));
      return;
    }
    const momento = agora();
    const uso = usos.get(chave.id);
    if (uso === undefined || momento - uso.inicio >= JANELA_MS) {
      usos.set(chave.id, { inicio: momento, total: 1 });
    } else {
      uso.total += 1;
      if (uso.total > limitePorMinuto) {
        const esperaSeg = Math.max(1, Math.ceil((uso.inicio + JANELA_MS - momento) / 1000));
        const erro = new RateLimitedError();
        await reply
          .header('Retry-After', String(esperaSeg))
          .code(erro.httpStatus)
          .send({ error: { code: erro.code, message: erro.message } });
        return;
      }
    }
    request.apiKeyId = chave.id;
  });
}

function extrairCaminho(request: FastifyRequest): string {
  const bruta = request.raw.url ?? request.url;
  const indice = bruta.indexOf('?');
  return indice < 0 ? bruta : bruta.slice(0, indice);
}

function ehRotaProtegida(caminho: string): boolean {
  if (caminho !== '/v1' && !caminho.startsWith('/v1/')) {
    return false;
  }
  return caminho !== '/v1/admin' && !caminho.startsWith('/v1/admin/');
}

function extrairChaveApresentada(request: FastifyRequest): string | null {
  const cabecalho = request.headers['x-api-key'];
  const valorCabecalho = Array.isArray(cabecalho) ? cabecalho[0] : cabecalho;
  if (typeof valorCabecalho === 'string' && valorCabecalho.trim() !== '') {
    return valorCabecalho.trim();
  }
  const bruta = request.raw.url ?? request.url;
  const indice = bruta.indexOf('?');
  if (indice >= 0) {
    const valor = new URLSearchParams(bruta.slice(indice + 1)).get('apikey');
    if (valor !== null && valor.trim() !== '') {
      return valor.trim();
    }
  }
  return null;
}

function gerarHash(valor: string): string {
  return createHash('sha256').update(valor, 'utf8').digest('hex');
}

function hashesIguais(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ba, bb);
}

function localizarPorHash(chaves: ApiKey[], hashRecebido: string): ApiKey | null {
  let encontrada: ApiKey | null = null;
  for (const chave of chaves) {
    if (hashesIguais(chave.keyHash, hashRecebido)) {
      encontrada = chave;
    }
  }
  return encontrada;
}

async function responderComErro(reply: FastifyReply, erro: AppError): Promise<void> {
  await reply.code(erro.httpStatus).send({ error: { code: erro.code, message: erro.message } });
}
