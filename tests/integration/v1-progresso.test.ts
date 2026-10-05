import { afterEach, describe, expect, it } from 'vitest';
import { ExecucoesRepository } from '../../src/database/index.js';
import { ExternalServiceError } from '../../src/shared/errors/index.js';
import { criarMundoV1, esperar, fecharMundoV1, type MundoV1 } from './v1-helpers.js';

const CNPJ_A = '12345678000190';

const mundos: MundoV1[] = [];

afterEach(async () => {
  while (mundos.length > 0) {
    const mundo = mundos.pop();
    if (mundo !== undefined) {
      await fecharMundoV1(mundo);
    }
  }
});

describe('GET /v1/execucoes/:id/progresso', () => {
  it('execução concluída emite done e encerra', async () => {
    const mundo = await criarMundoV1();
    mundos.push(mundo);
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
      url: `/v1/execucoes/${criada.execucaoId}/progresso`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: done');
    expect(res.body).toContain(criada.execucaoId);
    expect(res.body).not.toContain('event: erro');
  });

  it('execução falha emite erro com código do portal', async () => {
    const mundo = await criarMundoV1();
    mundos.push(mundo);
    const criada = await mundo.servico.iniciar({
      tipo: 'sefaz-bahia',
      params: { cnpj: CNPJ_A },
      artefatos: 'nenhum',
      inline: false,
      forceRefresh: false,
      apiKeyId: mundo.chaveA,
    });
    new ExecucoesRepository(mundo.tmp.banco).reservarProximaPendente();
    await mundo.servico.falhar(criada.execucaoId, new ExternalServiceError('Portal fora do ar'));
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/execucoes/${criada.execucaoId}/progresso`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('event: erro');
    expect(res.body).toContain('EXTERNAL_SERVICE_ERROR');
    expect(res.body).toContain('Portal fora do ar');
  });

  it('execução pendente transmite etapa e encerra no done', async () => {
    const mundo = await criarMundoV1();
    mundos.push(mundo);
    const criada = await mundo.servico.iniciar({
      tipo: 'sefaz-bahia',
      params: { cnpj: CNPJ_A },
      artefatos: 'nenhum',
      inline: false,
      forceRefresh: false,
      apiKeyId: mundo.chaveA,
    });
    const promessa = mundo.app.inject({
      method: 'GET',
      url: `/v1/execucoes/${criada.execucaoId}/progresso`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    await esperar(30);
    mundo.canal.publicar({
      execucaoId: criada.execucaoId,
      status: 'RUNNING',
      posicaoFila: null,
      etapa: 'consultando cadastro',
      tentativa: 0,
    });
    await esperar(30);
    mundo.canal.publicarFinal({
      execucaoId: criada.execucaoId,
      status: 'SUCCESS',
      posicaoFila: null,
      tentativa: 0,
    });
    const res = await promessa;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: status');
    expect(res.body).toContain('event: etapa');
    expect(res.body).toContain('consultando cadastro');
    expect(res.body).toContain('event: done');
  });

  it('id inexistente recebe 404', async () => {
    const mundo = await criarMundoV1();
    mundos.push(mundo);
    const res = await mundo.app.inject({
      method: 'GET',
      url: '/v1/execucoes/exe_inexistente/progresso',
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()?.error?.code).toBe('NOT_FOUND');
  });

  it('outra chave recebe 404', async () => {
    const mundo = await criarMundoV1();
    mundos.push(mundo);
    const criada = await mundo.servico.iniciar({
      tipo: 'sefaz-bahia',
      params: { cnpj: CNPJ_A },
      artefatos: 'nenhum',
      inline: false,
      forceRefresh: false,
      apiKeyId: mundo.chaveA,
    });
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/execucoes/${criada.execucaoId}/progresso`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()?.error?.code).toBe('NOT_FOUND');
  });
});
