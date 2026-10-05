import { afterEach, describe, expect, it } from 'vitest';
import type { ServicoExecucoes } from '../../src/app/routes/execucoes.js';
import { ExecucoesRepository } from '../../src/database/index.js';
import type { ExecucaoResposta } from '../../src/modules/automation/automation.types.js';
import { criarMundoV1, fecharMundoV1, type MundoV1, type OpcoesMundoV1 } from './v1-helpers.js';

const CNPJ_A = '12345678000190';
const CNPJ_B = '98765432000198';

const mundos: MundoV1[] = [];

afterEach(async () => {
  while (mundos.length > 0) {
    const mundo = mundos.pop();
    if (mundo !== undefined) {
      await fecharMundoV1(mundo);
    }
  }
});

async function montar(opcoes: OpcoesMundoV1 = {}): Promise<MundoV1> {
  const mundo = await criarMundoV1(opcoes);
  mundos.push(mundo);
  return mundo;
}

function stubFalha(code: string, message: string): ServicoExecucoes {
  const saida: ExecucaoResposta = {
    execucaoId: 'exe_falha',
    status: 'FAILED',
    error: { code, message },
  };
  return {
    iniciar: async () => saida,
    consultarSincrona: async () => saida,
    consultar: async () => saida,
    cancelar: async () => undefined,
  };
}

describe('GET /v1/consultas/:tipo', () => {
  it('acerto de cache responde 200 com dados', async () => {
    const mundo = await montar();
    const criada = await mundo.servico.iniciar({
      tipo: 'sefaz-bahia',
      params: { cnpj: CNPJ_A },
      artefatos: 'nenhum',
      inline: false,
      forceRefresh: false,
      apiKeyId: mundo.chaveA,
    });
    new ExecucoesRepository(mundo.tmp.banco).reservarProximaPendente();
    await mundo.servico.finalizar(criada.execucaoId, {
      sucesso: true,
      dados: { situacao: 'ativa' },
    });
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_A}`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    expect(res.statusCode).toBe(200);
    const corpo = res.json() as Record<string, unknown>;
    expect(corpo['status']).toBe('SUCCESS');
    expect(corpo['sucesso']).toBe(true);
    expect(corpo['dados']).toEqual({ situacao: 'ativa' });
    expect(corpo['cache']).toMatchObject({ hit: true });
  });

  it('aceita apikey na querystring', async () => {
    const mundo = await montar();
    const criada = await mundo.servico.iniciar({
      tipo: 'sefaz-bahia',
      params: { cnpj: CNPJ_A },
      artefatos: 'nenhum',
      inline: false,
      forceRefresh: false,
      apiKeyId: mundo.chaveA,
    });
    new ExecucoesRepository(mundo.tmp.banco).reservarProximaPendente();
    await mundo.servico.finalizar(criada.execucaoId, {
      sucesso: true,
      dados: { situacao: 'ativa' },
    });
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?apikey=${mundo.tokenB}&cnpj=${CNPJ_A}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'SUCCESS' });
  });

  it('estouro do wait responde 504 com execução em andamento', async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_B}&wait=0.05`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(504);
    const corpo = res.json() as {
      error: { code: string; message: string; details: { execucaoId: string } };
    };
    expect(corpo.error.code).toBe('TIMEOUT');
    expect(corpo.error.message).toMatch(/segue/);
    expect(corpo.error.details.execucaoId).toMatch(/^exe_/);
  });

  it('wait padrão é 30 segundos', async () => {
    let esperaRecebida = -1;
    const saida: ExecucaoResposta = {
      execucaoId: 'exe_stub',
      status: 'SUCCESS',
      resultado: { sucesso: true, dados: {} },
      cache: { hit: false },
    };
    const stub: ServicoExecucoes = {
      iniciar: async () => saida,
      consultarSincrona: async (entrada) => {
        esperaRecebida = entrada.waitSeg;
        return saida;
      },
      consultar: async () => saida,
      cancelar: async () => undefined,
    };
    const mundo = await montar({ servico: stub });
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_A}`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(200);
    expect(esperaRecebida).toBe(30);
  });

  it('wait acima do teto responde 400', async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_A}&wait=61`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()?.error?.code).toBe('VALIDATION_ERROR');
  });

  it('wait não numérico responde 400', async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_A}&wait=muito`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()?.error?.code).toBe('VALIDATION_ERROR');
  });

  it('parâmetros inválidos respondem 400', async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'GET',
      url: '/v1/consultas/sefaz-bahia?cnpj=123',
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()?.error?.code).toBe('VALIDATION_ERROR');
  });

  it('tipo desconhecido responde 400', async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'GET',
      url: '/v1/consultas/portal-fantasma?cnpj=12345678000190',
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()?.error?.code).toBe('VALIDATION_ERROR');
  });

  it('sem chave responde 401', async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_A}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()?.error?.code).toBe('UNAUTHORIZED');
  });

  it('erro do portal vira 502 com envelope', async () => {
    const mundo = await montar({ servico: stubFalha('EXTERNAL_SERVICE_ERROR', 'Portal fora do ar') });
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_A}`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: { code: 'EXTERNAL_SERVICE_ERROR', message: 'Portal fora do ar' },
    });
  });

  it('circuit breaker aberto vira 503 PORTAL_INDISPONIVEL', async () => {
    const mundo = await montar({ servico: stubFalha('PORTAL_INDISPONIVEL', 'Portal em cooldown') });
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_A}`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: { code: 'PORTAL_INDISPONIVEL', message: 'Portal em cooldown' },
    });
  });

  it('falha por timeout vira 504', async () => {
    const mundo = await montar({ servico: stubFalha('TIMEOUT', 'Execução estourou o teto') });
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_A}`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(504);
    expect(res.json()?.error?.code).toBe('TIMEOUT');
  });
});
