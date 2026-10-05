import { afterEach, describe, expect, it } from 'vitest';
import type { ServicoExecucoes } from '../../src/app/routes/execucoes.js';
import { ExecucoesRepository } from '../../src/database/index.js';
import type { ExecucaoResposta } from '../../src/modules/automation/automation.types.js';
import { criarMundoV1, esperar, fecharMundoV1, type MundoV1, type OpcoesMundoV1 } from './v1-helpers.js';

const CNPJ_A = '12345678000190';
const CNPJ_B = '98765432000198';
const CNPJ_C = '11122233344455';

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

function stubBase(saida: ExecucaoResposta): ServicoExecucoes {
  return {
    iniciar: async () => saida,
    consultarSincrona: async () => saida,
    consultar: async () => saida,
    cancelar: async () => undefined,
  };
}

describe('POST /v1/automacoes/:tipo', () => {
  it('cria execução e responde 202 com posição de fila', async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_A },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      execucaoId: expect.stringMatching(/^exe_/),
      status: 'PENDING',
      posicaoFila: 1,
      cache: { hit: false },
    });
  });

  it('tipo desconhecido responde 400 VALIDATION_ERROR', async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/portal-fantasma',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_A },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()?.error?.code).toBe('VALIDATION_ERROR');
  });

  it('parâmetros inválidos respondem 400 com envelope', async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: '123' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: { code: 'VALIDATION_ERROR', message: expect.any(String), details: expect.anything() },
    });
  });

  it('artefatos inválidos respondem 400', async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_A, artefatos: 'zip' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()?.error?.code).toBe('VALIDATION_ERROR');
  });

  it('sem chave responde 401 UNAUTHORIZED', async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia',
      payload: { cnpj: CNPJ_A },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()?.error?.code).toBe('UNAUTHORIZED');
  });

  it('acerto de cache sem wait responde 200 com shape do API.md', async () => {
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
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_A },
    });
    expect(res.statusCode).toBe(200);
    const corpo = res.json() as Record<string, unknown>;
    expect(corpo['status']).toBe('SUCCESS');
    expect(corpo['sucesso']).toBe(true);
    expect(corpo['dados']).toEqual({ situacao: 'ativa' });
    expect(corpo['documentos']).toEqual([]);
    expect(corpo['cache']).toMatchObject({ hit: true });
    expect(typeof corpo['execucaoId']).toBe('string');
  });

  it('?wait=0 sem conclusão responde 202', async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia?wait=0',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_B },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'PENDING', cache: { hit: false } });
  });

  it('?wait com acerto de cache responde 200', async () => {
    const mundo = await montar();
    const criada = await mundo.servico.iniciar({
      tipo: 'sefaz-bahia',
      params: { cnpj: CNPJ_B },
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
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia?wait=5',
      headers: { 'x-api-key': mundo.tokenB },
      payload: { cnpj: CNPJ_B },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'SUCCESS', sucesso: true });
  });

  it('async=false sem wait usa espera máxima de 60 segundos', async () => {
    let esperaRecebida = -1;
    const stub: ServicoExecucoes = {
      ...stubBase({
        execucaoId: 'exe_stub',
        status: 'SUCCESS',
        resultado: { sucesso: true, dados: {} },
        cache: { hit: false },
      }),
      consultarSincrona: async (entrada) => {
        esperaRecebida = entrada.waitSeg;
        return {
          execucaoId: 'exe_stub',
          status: 'SUCCESS',
          resultado: { sucesso: true, dados: {} },
          cache: { hit: false },
        };
      },
    };
    const mundo = await montar({ servico: stub });
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_A, async: false },
    });
    expect(res.statusCode).toBe(200);
    expect(esperaRecebida).toBe(60);
  });

  it('falha com wait mapeia o código do portal para o HTTP', async () => {
    const stub = stubBase({
      execucaoId: 'exe_falha',
      status: 'FAILED',
      error: { code: 'EXTERNAL_SERVICE_ERROR', message: 'Portal fora do ar' },
    });
    const mundo = await montar({ servico: stub });
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia?wait=5',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_A },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: { code: 'EXTERNAL_SERVICE_ERROR', message: 'Portal fora do ar' },
    });
  });

  it('?wait acima do teto responde 400', async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia?wait=61',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_A },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()?.error?.code).toBe('VALIDATION_ERROR');
  });

  it('inline monta pdfBase64 e printBase64 a partir do storage', async () => {
    const mundo = await montar();
    const base = await mundo.servico.iniciar({
      tipo: 'sefaz-bahia',
      params: { cnpj: CNPJ_C },
      artefatos: 'ambos',
      inline: false,
      forceRefresh: false,
      apiKeyId: mundo.chaveA,
    });
    const promessa = mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia?wait=5',
      headers: { 'x-api-key': mundo.tokenB },
      payload: { cnpj: CNPJ_C, artefatos: 'ambos', inline: true },
    });
    await esperar(50);
    new ExecucoesRepository(mundo.tmp.banco).reservarProximaPendente();
    await mundo.servico.finalizar(base.execucaoId, {
      sucesso: true,
      dados: { situacao: 'ativa' },
      pdfBase64: Buffer.from('pdf-teste').toString('base64'),
      printBase64: Buffer.from('print-teste').toString('base64'),
    });
    const res = await promessa;
    expect(res.statusCode).toBe(200);
    const corpo = res.json() as Record<string, unknown>;
    expect(corpo['pdfBase64']).toBe(Buffer.from('pdf-teste').toString('base64'));
    expect(corpo['printBase64']).toBe(Buffer.from('print-teste').toString('base64'));
  });

  it('sem inline não expõe base64 no JSON', async () => {
    const mundo = await montar();
    const criada = await mundo.servico.iniciar({
      tipo: 'sefaz-bahia',
      params: { cnpj: CNPJ_C },
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
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia?wait=5',
      headers: { 'x-api-key': mundo.tokenB },
      payload: { cnpj: CNPJ_C },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('pdfBase64');
    expect(res.body).not.toContain('printBase64');
  });
});

describe('GET /v1/execucoes/:id', () => {
  it('devolve a execução do dono', async () => {
    const mundo = await montar();
    const criada = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_A },
    });
    const id = (criada.json() as { execucaoId: string }).execucaoId;
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/execucoes/${id}`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ execucaoId: id, status: 'PENDING' });
  });

  it('outra chave recebe 404', async () => {
    const mundo = await montar();
    const criada = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_A },
    });
    const id = (criada.json() as { execucaoId: string }).execucaoId;
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/execucoes/${id}`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()?.error?.code).toBe('NOT_FOUND');
  });

  it('id inexistente recebe 404', async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'GET',
      url: '/v1/execucoes/exe_inexistente',
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()?.error?.code).toBe('NOT_FOUND');
  });
});

describe('DELETE /v1/execucoes/:id', () => {
  it('cancela pendente e responde 200', async () => {
    const mundo = await montar();
    const criada = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_A },
    });
    const id = (criada.json() as { execucaoId: string }).execucaoId;
    const res = await mundo.app.inject({
      method: 'DELETE',
      url: `/v1/execucoes/${id}`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ execucaoId: id, status: 'CANCELLED' });
  });

  it('execução em andamento responde 409 CONFLICT', async () => {
    const mundo = await montar();
    const criada = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_A },
    });
    const id = (criada.json() as { execucaoId: string }).execucaoId;
    new ExecucoesRepository(mundo.tmp.banco).reservarProximaPendente();
    const res = await mundo.app.inject({
      method: 'DELETE',
      url: `/v1/execucoes/${id}`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()?.error?.code).toBe('CONFLICT');
  });

  it('outra chave recebe 404', async () => {
    const mundo = await montar();
    const criada = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_A },
    });
    const id = (criada.json() as { execucaoId: string }).execucaoId;
    const res = await mundo.app.inject({
      method: 'DELETE',
      url: `/v1/execucoes/${id}`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/execucoes/:id/documentos', () => {
  it('lista documentos com url de download', async () => {
    const mundo = await montar();
    const criada = await mundo.servico.iniciar({
      tipo: 'sefaz-bahia',
      params: { cnpj: CNPJ_A },
      artefatos: 'ambos',
      inline: false,
      forceRefresh: false,
      apiKeyId: mundo.chaveA,
    });
    new ExecucoesRepository(mundo.tmp.banco).reservarProximaPendente();
    await mundo.servico.finalizar(criada.execucaoId, {
      sucesso: true,
      dados: { situacao: 'ativa' },
      pdfBase64: Buffer.from('pdf-teste').toString('base64'),
      printBase64: Buffer.from('print-teste').toString('base64'),
    });
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/execucoes/${criada.execucaoId}/documentos`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(200);
    const corpo = res.json() as {
      execucaoId: string;
      documentos: Array<{ id: string; url: string; contentType: string }>;
    };
    expect(corpo.execucaoId).toBe(criada.execucaoId);
    expect(corpo.documentos).toHaveLength(2);
    for (const documento of corpo.documentos) {
      expect(documento.url).toBe(`/v1/documentos/${documento.id}`);
    }
  });

  it('pendente lista vazia', async () => {
    const mundo = await montar();
    const criada = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_A },
    });
    const id = (criada.json() as { execucaoId: string }).execucaoId;
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/execucoes/${id}/documentos`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ execucaoId: id, documentos: [] });
  });

  it('outra chave recebe 404', async () => {
    const mundo = await montar();
    const criada = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_A },
    });
    const id = (criada.json() as { execucaoId: string }).execucaoId;
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/execucoes/${id}/documentos`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    expect(res.statusCode).toBe(404);
  });
});
