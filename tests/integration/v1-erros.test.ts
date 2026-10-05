import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { configurarErros } from '../../src/app/erros.js';
import { ConflictError, ValidationError } from '../../src/shared/errors/index.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    if (app !== undefined) {
      await app.close();
    }
  }
});

function montar(): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 });
  configurarErros(app);
  app.get('/v1/quebra', async () => {
    throw new Error('segredo interno do servidor');
  });
  app.get('/v1/conflito', async () => {
    throw new ConflictError('Execução já está em andamento');
  });
  app.get('/v1/invalido', async () => {
    throw new ValidationError('Entrada inválida', [{ path: 'cnpj', message: 'obrigatório' }]);
  });
  app.post('/v1/eco', async (request) => request.body);
  apps.push(app);
  return app;
}

describe('configurarErros', () => {
  it('erro desconhecido vira 500 genérico sem vazar detalhe', async () => {
    const app = montar();
    const res = await app.inject({ method: 'GET', url: '/v1/quebra' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Erro interno' },
    });
    expect(res.body).not.toContain('segredo interno');
    expect(res.body).not.toContain('stack');
  });

  it('AppError usa código e status próprios', async () => {
    const app = montar();
    const res = await app.inject({ method: 'GET', url: '/v1/conflito' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: 'CONFLICT', message: 'Execução já está em andamento' },
    });
  });

  it('ValidationError preserva details e responde 400', async () => {
    const app = montar();
    const res = await app.inject({ method: 'GET', url: '/v1/invalido' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Entrada inválida',
        details: [{ path: 'cnpj', message: 'obrigatório' }],
      },
    });
  });

  it('corpo acima de 32 KB responde 413 com envelope', async () => {
    const app = montar();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/eco',
      payload: { dado: 'x'.repeat(33 * 1024) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()?.error?.code).toBe('VALIDATION_ERROR');
  });

  it('JSON inválido responde 400 com envelope', async () => {
    const app = montar();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/eco',
      headers: { 'content-type': 'application/json' },
      payload: '{invalido',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()?.error?.code).toBe('VALIDATION_ERROR');
  });

  it('rota inexistente responde 404 com envelope', async () => {
    const app = montar();
    const res = await app.inject({ method: 'GET', url: '/v1/rota-fantasma' });
    expect(res.statusCode).toBe(404);
    expect(res.json()?.error?.code).toBe('NOT_FOUND');
  });
});
