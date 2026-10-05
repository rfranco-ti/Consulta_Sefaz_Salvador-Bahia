import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registrarAutenticacao } from '../../src/app/plugins/auth.js';
import { registrarAdminApiKeys } from '../../src/app/routes/admin-apikeys.js';
import { ApiKeysRepository } from '../../src/database/repositories/api-keys.repository.js';
import { criarBancoTemporario, type BancoTemporario } from './database-helpers.js';

const CHAVE_ADMIN = 'segredo-admin-teste-0123456789abcdef';
const ADMIN_ERRADA = 'segredo-errado-teste-9999999999999999';

interface Cenario {
  app: FastifyInstance;
  repositorio: ApiKeysRepository;
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

async function montar(comAdmin = true): Promise<Cenario> {
  const tmp = criarBancoTemporario();
  const repositorio = new ApiKeysRepository(tmp.banco);
  const app = Fastify({ logger: false });
  if (comAdmin) {
    registrarAdminApiKeys(app, { repositorio, adminKey: CHAVE_ADMIN });
  } else {
    registrarAdminApiKeys(app, { repositorio, adminKey: undefined });
  }
  registrarAutenticacao(app, { repositorio });
  app.get('/v1/ping', async (request) => ({ apiKeyId: request.apiKeyId }));
  abertos.push({ app, tmp });
  return { app, repositorio };
}

function cabecalhoAdmin(valor: string): Record<string, string> {
  return { 'x-admin-key': valor };
}

describe('admin de api keys', () => {
  it('cria key e devolve o token uma unica vez sem expor hash', async () => {
    const { app } = await montar();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/apikeys',
      headers: cabecalhoAdmin(CHAVE_ADMIN),
      payload: { nome: 'Colaboradora' },
    });
    expect(res.statusCode).toBe(201);
    const corpo = res.json() as { id: string; nome: string; apiKey: string; criadaEm: string };
    expect(corpo.id.startsWith('key_')).toBe(true);
    expect(corpo.nome).toBe('Colaboradora');
    expect(corpo.apiKey).toHaveLength(43);
    expect(typeof corpo.criadaEm).toBe('string');
    expect(res.body).not.toContain('keyHash');
    expect(res.body).not.toContain('key_hash');
  });

  it('grava so o sha-256 e o token autentica no hook', async () => {
    const { app, repositorio } = await montar();
    const criada = await app.inject({
      method: 'POST',
      url: '/v1/admin/apikeys',
      headers: cabecalhoAdmin(CHAVE_ADMIN),
      payload: { nome: 'Colaboradora' },
    });
    const corpo = criada.json() as { id: string; apiKey: string };
    const registro = repositorio.buscarPorId(corpo.id);
    expect(registro?.keyHash).toBe(sha256(corpo.apiKey));
    expect(registro?.keyHash).not.toBe(corpo.apiKey);
    const ping = await app.inject({
      method: 'GET',
      url: '/v1/ping',
      headers: { 'x-api-key': corpo.apiKey },
    });
    expect(ping.statusCode).toBe(200);
    expect(ping.json()).toEqual({ apiKeyId: corpo.id });
  });

  it('lista sem nunca expor hash ou token', async () => {
    const { app } = await montar();
    const criada = await app.inject({
      method: 'POST',
      url: '/v1/admin/apikeys',
      headers: cabecalhoAdmin(CHAVE_ADMIN),
      payload: { nome: 'Colaboradora' },
    });
    const token = (criada.json() as { id: string; apiKey: string }).apiKey;
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/apikeys',
      headers: cabecalhoAdmin(CHAVE_ADMIN),
    });
    expect(res.statusCode).toBe(200);
    const corpo = res.json() as {
      apikeys: Array<{ id: string; nome: string; ativa: boolean; criadaEm: string; ultimoUsoEm: string | null }>;
    };
    expect(corpo.apikeys).toHaveLength(1);
    expect(corpo.apikeys[0]).toMatchObject({ nome: 'Colaboradora', ativa: true });
    for (const item of corpo.apikeys) {
      expect('keyHash' in item).toBe(false);
      expect('apiKey' in item).toBe(false);
    }
    expect(res.body).not.toContain(token);
  });

  it('revoga e a key passa a responder 403 imediatamente', async () => {
    const { app, repositorio } = await montar();
    const criada = await app.inject({
      method: 'POST',
      url: '/v1/admin/apikeys',
      headers: cabecalhoAdmin(CHAVE_ADMIN),
      payload: { nome: 'Colaboradora' },
    });
    const corpo = criada.json() as { id: string; apiKey: string };
    const revogada = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/apikeys/${corpo.id}`,
      headers: cabecalhoAdmin(CHAVE_ADMIN),
    });
    expect(revogada.statusCode).toBe(200);
    expect(revogada.json()).toMatchObject({ id: corpo.id, ativa: false });
    expect(revogada.body).not.toContain('keyHash');
    expect(repositorio.buscarPorId(corpo.id)?.ativa).toBe(false);
    const ping = await app.inject({
      method: 'GET',
      url: '/v1/ping',
      headers: { 'x-api-key': corpo.apiKey },
    });
    expect(ping.statusCode).toBe(403);
  });

  it('revogar id inexistente responde 404', async () => {
    const { app } = await montar();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/admin/apikeys/key_inexistente',
      headers: cabecalhoAdmin(CHAVE_ADMIN),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Chave de API não encontrada' },
    });
  });

  it('admin key errada responde 403 sem ecoar o valor', async () => {
    const { app } = await montar();
    const post = await app.inject({
      method: 'POST',
      url: '/v1/admin/apikeys',
      headers: cabecalhoAdmin(ADMIN_ERRADA),
      payload: { nome: 'Colaboradora' },
    });
    expect(post.statusCode).toBe(403);
    expect(post.json()?.error?.code).toBe('FORBIDDEN');
    expect(post.body).not.toContain(ADMIN_ERRADA);
    const get = await app.inject({
      method: 'GET',
      url: '/v1/admin/apikeys',
      headers: cabecalhoAdmin(ADMIN_ERRADA),
    });
    expect(get.statusCode).toBe(403);
    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/admin/apikeys/key_qualquer',
      headers: cabecalhoAdmin(ADMIN_ERRADA),
    });
    expect(del.statusCode).toBe(403);
  });

  it('sem admin key no cabecalho responde 403', async () => {
    const { app } = await montar();
    const res = await app.inject({ method: 'GET', url: '/v1/admin/apikeys' });
    expect(res.statusCode).toBe(403);
    expect(res.json()?.error?.code).toBe('FORBIDDEN');
  });

  it('sem ADMIN_KEY configurada responde 403 tipado', async () => {
    const { app } = await montar(false);
    const get = await app.inject({
      method: 'GET',
      url: '/v1/admin/apikeys',
      headers: cabecalhoAdmin(CHAVE_ADMIN),
    });
    expect(get.statusCode).toBe(403);
    expect(get.json()?.error?.code).toBe('FORBIDDEN');
    const post = await app.inject({
      method: 'POST',
      url: '/v1/admin/apikeys',
      headers: cabecalhoAdmin(CHAVE_ADMIN),
      payload: { nome: 'Colaboradora' },
    });
    expect(post.statusCode).toBe(403);
  });

  it('body invalido responde 400 VALIDATION_ERROR', async () => {
    const { app } = await montar();
    const semNome = await app.inject({
      method: 'POST',
      url: '/v1/admin/apikeys',
      headers: cabecalhoAdmin(CHAVE_ADMIN),
      payload: {},
    });
    expect(semNome.statusCode).toBe(400);
    const corpo = semNome.json() as { error: { code: string; details: unknown[] } };
    expect(corpo.error.code).toBe('VALIDATION_ERROR');
    expect(corpo.error.details.length).toBeGreaterThan(0);
    const nomeVazio = await app.inject({
      method: 'POST',
      url: '/v1/admin/apikeys',
      headers: cabecalhoAdmin(CHAVE_ADMIN),
      payload: { nome: '   ' },
    });
    expect(nomeVazio.statusCode).toBe(400);
  });
});
