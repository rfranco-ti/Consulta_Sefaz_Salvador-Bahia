import type Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registrarSaude } from '../../src/app/plugins/saude.js';
import { openDatabase } from '../../src/database/client.js';
import {
  criarBancoTemporario,
  criarChaveApi,
  criarExecucaoPendente,
  type BancoTemporario,
} from './database-helpers.js';

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

function novaApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  aplicacoes.push(app);
  return app;
}

function bancoTemporario(): BancoTemporario {
  const tmp = criarBancoTemporario();
  bancos.push(tmp);
  return tmp;
}

function semearExecucao(
  banco: Database.Database,
  entrada: {
    id: string;
    tipo: string;
    status: string;
    duracaoMs: number | null;
    ticket: number;
    apiKeyId: string;
  },
): void {
  banco
    .prepare(
      'INSERT INTO execucoes (id, tipo, status, payload, payload_bruto, resultado, error, attempts, api_key_id, ticket, cache_version, posicao_fila, criado_em, iniciado_em, finalizado_em, duracao_ms) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, 1, NULL, ?, NULL, NULL, ?)',
    )
    .run(
      entrada.id,
      entrada.tipo,
      entrada.status,
      '{}',
      '{}',
      entrada.apiKeyId,
      entrada.ticket,
      new Date().toISOString(),
      entrada.duracaoMs,
    );
}

describe('saude da aplicacao', () => {
  it('GET /health responde 200 com status, versao e uptime', async () => {
    const app = novaApp();
    registrarSaude(app, { versao: '9.9.9-teste', agoraMs: () => 42_000, inicioMs: 0 });

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', versao: '9.9.9-teste', uptimeSeg: 42 });
  });

  it('GET /health sem opcoes usa versao do package.json', async () => {
    const app = novaApp();
    registrarSaude(app);

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const corpo = res.json() as { status: string; versao: string; uptimeSeg: number };
    expect(corpo.status).toBe('ok');
    expect(corpo.versao).toMatch(/^\d+\.\d+\.\d+/);
    expect(corpo.uptimeSeg).toEqual(expect.any(Number));
  });

  it('GET /ready com dependencias ok responde 200 com status por dependencia', async () => {
    const app = novaApp();
    registrarSaude(app, {
      versao: '9.9.9-teste',
      agoraMs: () => 60_000,
      inicioMs: 0,
      verificarBanco: async () => ({ latenciaMs: 3 }),
      lerFila: async () => ({ pendentes: 2, workerVivo: true }),
      lerNavegador: async () => ({ quente: true, ocupados: 1, ociosos: 0, criados: 2 }),
    });

    const res = await app.inject({ method: 'GET', url: '/ready' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      versao: '9.9.9-teste',
      uptimeSeg: 60,
      dependencias: {
        banco: { status: 'ok', latenciaMs: 3 },
        fila: { status: 'ok', pendentes: 2, workerVivo: true },
        navegador: { status: 'ok', quente: true, ocupados: 1, ociosos: 0, criados: 2 },
      },
    });
  });

  it('GET /ready com banco fora responde 503 sem vazar detalhe interno', async () => {
    const app = novaApp();
    registrarSaude(app, {
      versao: '9.9.9-teste',
      verificarBanco: async () => {
        throw new Error('conexao recusada em 127.0.0.1:5432');
      },
      lerFila: async () => ({ pendentes: 0, workerVivo: true }),
      lerNavegador: async () => ({ quente: false, ocupados: 0, ociosos: 0, criados: 0 }),
    });

    const res = await app.inject({ method: 'GET', url: '/ready' });

    expect(res.statusCode).toBe(503);
    const corpo = res.json() as {
      status: string;
      dependencias: { banco: { status: string; mensagem: string } };
    };
    expect(corpo.status).toBe('falha');
    expect(corpo.dependencias.banco.status).toBe('falha');
    expect(typeof corpo.dependencias.banco.mensagem).toBe('string');
    expect(res.body).not.toContain('127.0.0.1');
  });

  it('GET /ready com worker parado responde 503 com pendentes no corpo', async () => {
    const app = novaApp();
    registrarSaude(app, {
      verificarBanco: async () => ({ latenciaMs: 1 }),
      lerFila: async () => ({ pendentes: 5, workerVivo: false }),
      lerNavegador: async () => ({ quente: true, ocupados: 0, ociosos: 1, criados: 1 }),
    });

    const res = await app.inject({ method: 'GET', url: '/ready' });

    expect(res.statusCode).toBe(503);
    const corpo = res.json() as {
      status: string;
      dependencias: {
        fila: { status: string; pendentes: number; workerVivo: boolean; mensagem: string };
      };
    };
    expect(corpo.status).toBe('falha');
    expect(corpo.dependencias.fila.status).toBe('falha');
    expect(corpo.dependencias.fila.pendentes).toBe(5);
    expect(corpo.dependencias.fila.workerVivo).toBe(false);
    expect(typeof corpo.dependencias.fila.mensagem).toBe('string');
  });

  it('GET /ready com pool fora responde 503 com navegador em falha', async () => {
    const app = novaApp();
    registrarSaude(app, {
      verificarBanco: async () => ({ latenciaMs: 1 }),
      lerFila: async () => ({ pendentes: 0, workerVivo: true }),
      lerNavegador: async () => {
        throw new Error('navegador desconectado');
      },
    });

    const res = await app.inject({ method: 'GET', url: '/ready' });

    expect(res.statusCode).toBe(503);
    const corpo = res.json() as {
      dependencias: { navegador: { status: string; mensagem: string } };
    };
    expect(corpo.dependencias.navegador.status).toBe('falha');
    expect(typeof corpo.dependencias.navegador.mensagem).toBe('string');
    expect(res.body).not.toContain('desconectado');
  });

  it('GET /ready com padroes le banco e fila reais do sqlite', async () => {
    const tmp = bancoTemporario();
    const chave = criarChaveApi(tmp.banco);
    criarExecucaoPendente(tmp.banco, { id: 'exe_pronto_1', apiKeyId: chave.id });
    criarExecucaoPendente(tmp.banco, { id: 'exe_pronto_2', apiKeyId: chave.id });
    const app = novaApp();
    registrarSaude(app, { banco: tmp.banco });

    const res = await app.inject({ method: 'GET', url: '/ready' });

    expect(res.statusCode).toBe(503);
    const corpo = res.json() as {
      dependencias: {
        banco: { status: string };
        fila: { status: string; pendentes: number; workerVivo: boolean };
        navegador: { status: string };
      };
    };
    expect(corpo.dependencias.banco.status).toBe('ok');
    expect(corpo.dependencias.fila.pendentes).toBe(2);
    expect(corpo.dependencias.fila.workerVivo).toBe(false);
    expect(corpo.dependencias.navegador.status).toBe('ok');
  });

  it('GET /metrics responde 200 com contadores agregados do sqlite', async () => {
    const tmp = bancoTemporario();
    const chave = criarChaveApi(tmp.banco);
    semearExecucao(tmp.banco, {
      id: 'exe_m1',
      tipo: 'sefaz-bahia',
      status: 'SUCCESS',
      duracaoMs: 100,
      ticket: 1,
      apiKeyId: chave.id,
    });
    semearExecucao(tmp.banco, {
      id: 'exe_m2',
      tipo: 'sefaz-bahia',
      status: 'SUCCESS',
      duracaoMs: 200,
      ticket: 2,
      apiKeyId: chave.id,
    });
    semearExecucao(tmp.banco, {
      id: 'exe_m3',
      tipo: 'sefaz-bahia',
      status: 'SUCCESS',
      duracaoMs: 300,
      ticket: 3,
      apiKeyId: chave.id,
    });
    semearExecucao(tmp.banco, {
      id: 'exe_m4',
      tipo: 'sefaz-bahia',
      status: 'SUCCESS',
      duracaoMs: 400,
      ticket: 4,
      apiKeyId: chave.id,
    });
    semearExecucao(tmp.banco, {
      id: 'exe_m5',
      tipo: 'iptu-salvador',
      status: 'SUCCESS',
      duracaoMs: 500,
      ticket: 5,
      apiKeyId: chave.id,
    });
    semearExecucao(tmp.banco, {
      id: 'exe_m6',
      tipo: 'cadin-salvador',
      status: 'FAILED',
      duracaoMs: null,
      ticket: 6,
      apiKeyId: chave.id,
    });
    semearExecucao(tmp.banco, {
      id: 'exe_m7',
      tipo: 'ficha-cadastral',
      status: 'CANCELLED',
      duracaoMs: null,
      ticket: 7,
      apiKeyId: chave.id,
    });
    semearExecucao(tmp.banco, {
      id: 'exe_m8',
      tipo: 'consulta-inscricoes',
      status: 'PENDING',
      duracaoMs: null,
      ticket: 8,
      apiKeyId: chave.id,
    });
    semearExecucao(tmp.banco, {
      id: 'exe_m9',
      tipo: 'consulta-inscricoes',
      status: 'PENDING',
      duracaoMs: null,
      ticket: 9,
      apiKeyId: chave.id,
    });
    const agora = new Date().toISOString();
    tmp.banco
      .prepare(
        'INSERT INTO cache_consultas (chave, tipo, dados, cache_version, criado_em, expira_em, tamanho_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run('chave-cache-1', 'sefaz-bahia', '{}', 1, agora, '2999-01-01T00:00:00.000Z', 2);
    tmp.banco
      .prepare(
        'INSERT INTO cache_consultas (chave, tipo, dados, cache_version, criado_em, expira_em, tamanho_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run('chave-cache-2', 'sefaz-bahia', '{}', 1, agora, '2999-01-01T00:00:00.000Z', 2);
    const app = novaApp();
    registrarSaude(app, { banco: tmp.banco, agoraMs: () => 90_000, inicioMs: 0 });

    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.statusCode).toBe(200);
    const corpo = res.json() as {
      versao: string;
      uptimeSeg: number;
      execucoes: {
        porStatus: Record<string, number>;
        porTipoStatus: Record<string, Record<string, number>>;
        duracaoMs: Record<string, { p50: number; p95: number; amostras: number }>;
      };
      cache: { hits: number; misses: number; entradas: number };
      fila: { pendentes: number };
      navegador: { quente: boolean; ocupados: number; ociosos: number; criados: number };
      processo: { uptimeSeg: number; rssBytes: number };
    };
    expect(corpo.versao).toMatch(/^\d+\.\d+\.\d+/);
    expect(corpo.uptimeSeg).toBe(90);
    expect(corpo.execucoes.porStatus).toEqual({
      PENDING: 2,
      RUNNING: 0,
      SUCCESS: 5,
      FAILED: 1,
      CANCELLED: 1,
    });
    expect(corpo.execucoes.porTipoStatus).toEqual({
      'sefaz-bahia': { SUCCESS: 4 },
      'iptu-salvador': { SUCCESS: 1 },
      'cadin-salvador': { FAILED: 1 },
      'ficha-cadastral': { CANCELLED: 1 },
      'consulta-inscricoes': { PENDING: 2 },
    });
    expect(corpo.execucoes.duracaoMs).toEqual({
      'sefaz-bahia': { p50: 200, p95: 400, amostras: 4 },
      'iptu-salvador': { p50: 500, p95: 500, amostras: 1 },
    });
    expect(corpo.cache).toEqual({ hits: 0, misses: 0, entradas: 2 });
    expect(corpo.fila).toEqual({ pendentes: 2 });
    expect(corpo.navegador).toEqual({ quente: false, ocupados: 0, ociosos: 0, criados: 0 });
    expect(corpo.processo.uptimeSeg).toBe(90);
    expect(corpo.processo.rssBytes).toBeGreaterThan(0);
  });

  it('GET /metrics com banco sem tabelas responde 500 em portugues', async () => {
    const memoria = openDatabase(':memory:');
    const app = novaApp();
    registrarSaude(app, { banco: memoria });

    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Falha ao coletar métricas' },
    });
    memoria.close();
  });
});
