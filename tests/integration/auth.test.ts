import { createHash, randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registrarAutenticacao } from '../../src/app/plugins/auth.js';
import { ApiKeysRepository } from '../../src/database/repositories/api-keys.repository.js';
import { criarBancoTemporario, type BancoTemporario } from './database-helpers.js';

interface Cenario {
  app: FastifyInstance;
  tokenValido: string;
  idValido: string;
  tokenInativo: string;
  avancar: (ms: number) => void;
}

const abertos: Array<{ app: FastifyInstance; tmp: BancoTemporario }> = [];

afterEach(async () => {
  while (abertos.length > 0) {
    const item = abertos.pop();
    if (item !== undefined) {
      await item.app.close();
      item.tmp.limpar();
    }
  }
});

function sha256(valor: string): string {
  return createHash('sha256').update(valor, 'utf8').digest('hex');
}

async function montar(limitePorMinuto = 60): Promise<Cenario> {
  const tmp = criarBancoTemporario();
  const repositorio = new ApiKeysRepository(tmp.banco);
  const tokenValido = randomBytes(32).toString('base64url');
  const valida = repositorio.criar({
    id: `key_${randomBytes(6).toString('hex')}`,
    nome: 'Colaboradora',
    keyHash: sha256(tokenValido),
  });
  const tokenInativo = randomBytes(32).toString('base64url');
  const inativa = repositorio.criar({
    id: `key_${randomBytes(6).toString('hex')}`,
    nome: 'Ex-colaborador',
    keyHash: sha256(tokenInativo),
  });
  repositorio.revogar(inativa.id);

  let momento = 1_000_000;
  const app = Fastify({ logger: false });
  registrarAutenticacao(app, {
    repositorio,
    agora: () => momento,
    limitePorMinuto,
  });
  app.get('/v1/ping', async (request) => ({ apiKeyId: request.apiKeyId }));
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/v1/admin/apikeys', async () => ({ ok: true }));
  abertos.push({ app, tmp });
  return {
    app,
    tokenValido,
    idValido: valida.id,
    tokenInativo,
    avancar: (ms: number) => {
      momento += ms;
    },
  };
}

describe('autenticacao por api key', () => {
  it('sem chave responde 401 UNAUTHORIZED', async () => {
    const { app } = await montar();
    const res = await app.inject({ method: 'GET', url: '/v1/ping' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'API key ausente ou invalida' },
    });
  });

  it('chave invalida responde 401 sem ecoar o valor', async () => {
    const { app } = await montar();
    const invalida = randomBytes(32).toString('base64url');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/ping',
      headers: { 'x-api-key': invalida },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'API key ausente ou invalida' },
    });
    expect(res.body).not.toContain(invalida);
  });

  it('chave vazia responde 401', async () => {
    const { app } = await montar();
    const porHeader = await app.inject({
      method: 'GET',
      url: '/v1/ping',
      headers: { 'x-api-key': '' },
    });
    expect(porHeader.statusCode).toBe(401);
    const porQuery = await app.inject({ method: 'GET', url: '/v1/ping?apikey=' });
    expect(porQuery.statusCode).toBe(401);
  });

  it('chave valida no header autentica e expoe apiKeyId', async () => {
    const { app, tokenValido, idValido } = await montar();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/ping',
      headers: { 'x-api-key': tokenValido },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ apiKeyId: idValido });
  });

  it('chave valida na query ?apikey= autentica', async () => {
    const { app, tokenValido, idValido } = await montar();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/ping?apikey=${tokenValido}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ apiKeyId: idValido });
  });

  it('chave inativa responde 403 FORBIDDEN', async () => {
    const { app, tokenInativo } = await montar();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/ping',
      headers: { 'x-api-key': tokenInativo },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: { code: 'FORBIDDEN', message: 'Chave de API revogada' },
    });
    expect(res.body).not.toContain(tokenInativo);
  });

  it('estoura o limite e libera na janela seguinte com relogio falso', async () => {
    const { app, tokenValido, avancar } = await montar(3);
    const cabecalho = { 'x-api-key': tokenValido };
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/v1/ping', headers: cabecalho });
      expect(res.statusCode).toBe(200);
    }
    const bloqueada = await app.inject({ method: 'GET', url: '/v1/ping', headers: cabecalho });
    expect(bloqueada.statusCode).toBe(429);
    expect(bloqueada.json()).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Limite de requisicoes atingido' },
    });
    expect(bloqueada.headers['retry-after']).toBeDefined();
    avancar(61_000);
    const liberada = await app.inject({ method: 'GET', url: '/v1/ping', headers: cabecalho });
    expect(liberada.statusCode).toBe(200);
  });

  it('rotas fora de /v1 passam sem chave', async () => {
    const { app } = await montar();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('rotas admin passam pelo hook sem chave de usuario', async () => {
    const { app } = await montar();
    const res = await app.inject({ method: 'GET', url: '/v1/admin/apikeys' });
    expect(res.statusCode).toBe(200);
  });
});
