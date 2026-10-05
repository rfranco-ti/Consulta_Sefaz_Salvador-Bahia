import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../database/client.js';
import {
  ApiKeysRepository,
  type ApiKey,
} from '../../database/repositories/api-keys.repository.js';
import {
  AppError,
  ForbiddenError,
  InternalError,
} from '../../shared/errors/index.js';

export interface OpcoesAdminApiKeys {
  adminKey: string | undefined;
  repositorio: ApiKeysRepository;
}

interface ApiKeyResposta {
  id: string;
  nome: string;
  ativa: boolean;
  criadaEm: string;
  ultimoUsoEm: string | null;
}

const criarApikeySchema = z.object({
  nome: z
    .string({ error: 'Nome da chave e obrigatorio' })
    .trim()
    .min(1, { error: 'Nome da chave e obrigatorio' })
    .max(120, { error: 'Nome deve ter no maximo 120 caracteres' }),
});

const paramsIdSchema = z.object({
  id: z
    .string({ error: 'Identificador e obrigatorio' })
    .trim()
    .min(1, { error: 'Identificador e obrigatorio' }),
});

export function registrarAdminApiKeys(
  app: FastifyInstance,
  parcial?: Partial<OpcoesAdminApiKeys>,
): void {
  const repositorio = parcial?.repositorio ?? new ApiKeysRepository(db());
  const chaveAdmin = parcial?.adminKey !== undefined ? parcial.adminKey : env.ADMIN_KEY;

  app.post('/v1/admin/apikeys', async (request, reply) => {
    try {
      exigirAdmin(request, chaveAdmin);
      const corpo = criarApikeySchema.parse(request.body);
      const token = randomBytes(32).toString('base64url');
      const registro = repositorio.criar({
        id: `key_${randomBytes(12).toString('hex')}`,
        nome: corpo.nome,
        keyHash: createHash('sha256').update(token, 'utf8').digest('hex'),
      });
      await reply.code(201).send({
        id: registro.id,
        nome: registro.nome,
        apiKey: token,
        criadaEm: registro.criadaEm,
      });
    } catch (erro) {
      await responderComErro(reply, erro);
    }
  });

  app.get('/v1/admin/apikeys', async (request, reply) => {
    try {
      exigirAdmin(request, chaveAdmin);
      await reply.send({ apikeys: repositorio.listar().map(paraResposta) });
    } catch (erro) {
      await responderComErro(reply, erro);
    }
  });

  app.delete('/v1/admin/apikeys/:id', async (request, reply) => {
    try {
      exigirAdmin(request, chaveAdmin);
      const params = paramsIdSchema.parse(request.params);
      await reply.send(paraResposta(repositorio.revogar(params.id)));
    } catch (erro) {
      await responderComErro(reply, erro);
    }
  });
}

function exigirAdmin(request: FastifyRequest, chaveAdmin: string | undefined): void {
  if (chaveAdmin === undefined) {
    throw new ForbiddenError('Administracao desabilitada: ADMIN_KEY nao configurada');
  }
  const apresentada = extrairAdminKey(request);
  if (apresentada === null || !adminKeyConfere(apresentada, chaveAdmin)) {
    throw new ForbiddenError('Chave de administracao ausente ou invalida');
  }
}

function extrairAdminKey(request: FastifyRequest): string | null {
  const valor = request.headers['x-admin-key'];
  const primeiro = Array.isArray(valor) ? valor[0] : valor;
  if (typeof primeiro !== 'string' || primeiro.trim() === '') {
    return null;
  }
  return primeiro;
}

function adminKeyConfere(apresentada: string, esperada: string): boolean {
  const a = createHash('sha256').update(apresentada, 'utf8').digest();
  const b = createHash('sha256').update(esperada, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function paraResposta(chave: ApiKey): ApiKeyResposta {
  return {
    id: chave.id,
    nome: chave.nome,
    ativa: chave.ativa,
    criadaEm: chave.criadaEm,
    ultimoUsoEm: chave.ultimoUsoEm,
  };
}

function detalhesValidacao(erro: z.ZodError): Array<{ path: string; message: string }> {
  return erro.issues.map((item) => ({
    path: item.path.map(String).join('.'),
    message: item.message,
  }));
}

async function responderComErro(reply: FastifyReply, erro: unknown): Promise<void> {
  if (erro instanceof z.ZodError) {
    await reply.code(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Dados invalidos',
        details: detalhesValidacao(erro),
      },
    });
    return;
  }
  const tipado = erro instanceof AppError ? erro : new InternalError('Erro interno');
  await reply.code(tipado.httpStatus).send({
    error: {
      code: tipado.code,
      message: tipado.message,
      ...(tipado.details !== undefined ? { details: tipado.details } : {}),
    },
  });
}
