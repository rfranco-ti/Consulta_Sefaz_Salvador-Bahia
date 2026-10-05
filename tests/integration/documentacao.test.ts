import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registrarAutenticacao } from '../../src/app/plugins/auth.js';
import { registrarDocumentacao } from '../../src/app/plugins/documentacao.js';
import { registrarSaude } from '../../src/app/plugins/saude.js';
import { ApiKeysRepository } from '../../src/database/repositories/api-keys.repository.js';
import {
  criarBancoTemporario,
  type BancoTemporario,
} from './database-helpers.js';

const VERSAO_DOCS = '7.7.7-docs';

const aplicacoes: FastifyInstance[] = [];
const bancos: BancoTemporario[] = [];

afterEach(async () => {
  while (aplicacoes.length > 0) {
    const app = aplicacoes.pop();
    if (app !== undefined) {
      await app.close();
    }
  }
  while (bancos.length > 0) {
    const tmp = bancos.pop();
    if (tmp !== undefined) {
      tmp.limpar();
    }
  }
});

async function montarComDocs(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await registrarDocumentacao(app, { versao: VERSAO_DOCS });
  registrarSaude(app, {
    versao: VERSAO_DOCS,
    agoraMs: () => 60_000,
    inicioMs: 0,
    verificarBanco: async () => ({ latenciaMs: 1 }),
    lerFila: async () => ({ pendentes: 0, workerVivo: true }),
    lerNavegador: async () => ({ quente: false, ocupados: 0, ociosos: 0, criados: 0 }),
  });
  aplicacoes.push(app);
  return app;
}

describe('documentacao da api', () => {
  it('GET /docs serve o Swagger UI em HTML local', async () => {
    const app = await montarComDocs();

    const res = await app.inject({ method: 'GET', url: '/docs' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body.toLowerCase()).toContain('swagger');
  });

  it('GET /docs/json expoe o OpenAPI com rotas de saude e esquemas zod', async () => {
    const app = await montarComDocs();

    const res = await app.inject({ method: 'GET', url: '/docs/json' });

    expect(res.statusCode).toBe(200);
    const documento = res.json() as {
      openapi: string;
      info: { title: string; version: string; description: string };
      paths: Record<string, unknown>;
      components: { schemas: Record<string, Record<string, unknown>> };
    };
    expect(documento.openapi).toMatch(/^3\./);
    expect(documento.info.title).toBe('api-sefaz-ssa');
    expect(documento.info.version).toBe(VERSAO_DOCS);
    expect(documento.info.description.length).toBeGreaterThan(0);
    expect(Object.keys(documento.paths)).toEqual(
      expect.arrayContaining(['/health', '/ready', '/metrics']),
    );
    expect(documento.components.schemas['Artefatos']).toEqual({
      type: 'string',
      enum: ['nenhum', 'pdf', 'print', 'ambos'],
    });
    const tipo = documento.components.schemas['TipoAutomacao'] as { enum: string[] };
    expect(tipo.enum).toHaveLength(9);
    expect(tipo.enum).toContain('sefaz-bahia');
    const params = documento.components.schemas['sefaz-bahia-params'] as {
      type: string;
      properties: Record<string, unknown>;
    };
    expect(params.type).toBe('object');
    expect(Object.keys(params.properties)).toContain('cnpj');
  });

  it('saude e docs passam sem api key mesmo com autenticacao registrada', async () => {
    const tmp = criarBancoTemporario();
    bancos.push(tmp);
    const app = Fastify({ logger: false });
    aplicacoes.push(app);
    registrarAutenticacao(app, {
      repositorio: new ApiKeysRepository(tmp.banco),
      agora: () => 1_000_000,
      limitePorMinuto: 60,
    });
    await registrarDocumentacao(app, { versao: VERSAO_DOCS });
    registrarSaude(app, {
      versao: VERSAO_DOCS,
      verificarBanco: async () => ({ latenciaMs: 1 }),
      lerFila: async () => ({ pendentes: 0, workerVivo: true }),
      lerNavegador: async () => ({ quente: false, ocupados: 0, ociosos: 0, criados: 0 }),
    });

    for (const url of ['/health', '/ready', '/metrics', '/docs', '/docs/json']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
    }
  });
});
