import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, InternalError, UnauthorizedError } from '../shared/errors/index.js';

export interface DetalheValidacao {
  path: string;
  message: string;
}

export function detalhesValidacao(erro: z.ZodError): DetalheValidacao[] {
  return erro.issues.map((item) => ({
    path: item.path.map(String).join('.'),
    message: item.message,
  }));
}

export function exigirApiKey(request: FastifyRequest): void {
  if (request.apiKeyId === '') {
    throw new UnauthorizedError();
  }
}

export async function responderComErro(reply: FastifyReply, erro: unknown): Promise<void> {
  if (erro instanceof z.ZodError) {
    await reply.code(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Dados inválidos',
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
      ...(tipado.details === undefined ? {} : { details: tipado.details }),
    },
  });
}

function campoTexto(erro: unknown, campo: string): string | null {
  if (typeof erro !== 'object' || erro === null) {
    return null;
  }
  const valor = (erro as Record<string, unknown>)[campo];
  return typeof valor === 'string' ? valor : null;
}

function campoStatus(erro: unknown): number | null {
  if (typeof erro !== 'object' || erro === null) {
    return null;
  }
  const valor = (erro as Record<string, unknown>)['statusCode'];
  return typeof valor === 'number' ? valor : null;
}

export function configurarErros(app: FastifyInstance): void {
  app.setErrorHandler(async (erro, _request, reply) => {
    if (reply.sent) {
      return;
    }
    const codigo = campoTexto(erro, 'code');
    const status = campoStatus(erro);
    if (codigo === 'FST_ERR_CTP_BODY_TOO_LARGE' || status === 413) {
      await reply.code(413).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Corpo da requisição excede o limite de 32 KB',
        },
      });
      return;
    }
    if (codigo !== null && codigo.startsWith('FST_')) {
      await reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Requisição inválida' },
      });
      return;
    }
    if (status === 400) {
      await reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Corpo da requisição inválido' },
      });
      return;
    }
    await responderComErro(reply, erro);
  });
  app.setNotFoundHandler(async (request, reply) => {
    await reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Rota não encontrada: ${request.method} ${request.url}`,
      },
    });
  });
}
