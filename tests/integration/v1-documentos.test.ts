import { afterEach, describe, expect, it } from 'vitest';
import { ExecucoesRepository } from '../../src/database/index.js';
import { criarMundoV1, fecharMundoV1, type MundoV1 } from './v1-helpers.js';

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

async function finalizarComArtefatos(mundo: MundoV1): Promise<string[]> {
  const criada = await mundo.servico.iniciar({
    tipo: 'sefaz-bahia',
    params: { cnpj: CNPJ_A },
    artefatos: 'ambos',
    inline: false,
    forceRefresh: false,
    apiKeyId: mundo.chaveA,
  });
  new ExecucoesRepository(mundo.tmp.banco).reservarProximaPendente();
  const resposta = await mundo.servico.finalizar(criada.execucaoId, {
    sucesso: true,
    dados: { situacao: 'ativa' },
    pdfBase64: Buffer.from('conteudo-pdf').toString('base64'),
    printBase64: Buffer.from('conteudo-print').toString('base64'),
  });
  return (resposta.resultado?.documentos ?? []).map((documento) => documento.id);
}

describe('GET /v1/documentos/:id', () => {
  it('descarrega o pdf com content-type e disposition', async () => {
    const mundo = await criarMundoV1();
    mundos.push(mundo);
    const ids = await finalizarComArtefatos(mundo);
    expect(ids).toHaveLength(2);
    const respostas = await Promise.all(
      ids.map((id) =>
        mundo.app.inject({
          method: 'GET',
          url: `/v1/documentos/${id}`,
          headers: { 'x-api-key': mundo.tokenA },
        }),
      ),
    );
    const pdf = respostas.find((res) => (res.headers['content-type'] ?? '').includes('application/pdf'));
    const print = respostas.find((res) => (res.headers['content-type'] ?? '').includes('image/jpeg'));
    expect(pdf?.statusCode).toBe(200);
    expect(pdf?.headers['content-disposition']).toMatch(/^attachment; filename="/);
    expect(pdf?.rawPayload.equals(Buffer.from('conteudo-pdf'))).toBe(true);
    expect(print?.statusCode).toBe(200);
    expect(print?.rawPayload.equals(Buffer.from('conteudo-print'))).toBe(true);
  });

  it('participante do single-flight descarrega', async () => {
    const mundo = await criarMundoV1();
    mundos.push(mundo);
    await mundo.servico.iniciar({
      tipo: 'sefaz-bahia',
      params: { cnpj: CNPJ_A },
      artefatos: 'ambos',
      inline: false,
      forceRefresh: false,
      apiKeyId: mundo.chaveA,
    });
    await mundo.servico.iniciar({
      tipo: 'sefaz-bahia',
      params: { cnpj: CNPJ_A },
      artefatos: 'nenhum',
      inline: false,
      forceRefresh: false,
      apiKeyId: mundo.chaveB,
    });
    const ids = await finalizarComArtefatos(mundo);
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/documentos/${ids[0]}`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    expect(res.statusCode).toBe(200);
  });

  it('outra chave recebe 404', async () => {
    const mundo = await criarMundoV1();
    mundos.push(mundo);
    const ids = await finalizarComArtefatos(mundo);
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/documentos/${ids[0]}`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()?.error?.code).toBe('NOT_FOUND');
  });

  it('id inexistente recebe 404', async () => {
    const mundo = await criarMundoV1();
    mundos.push(mundo);
    const res = await mundo.app.inject({
      method: 'GET',
      url: '/v1/documentos/doc_inexistente',
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()?.error?.code).toBe('NOT_FOUND');
  });

  it('id vazio responde 400', async () => {
    const mundo = await criarMundoV1();
    mundos.push(mundo);
    const res = await mundo.app.inject({
      method: 'GET',
      url: '/v1/documentos/%20',
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()?.error?.code).toBe('VALIDATION_ERROR');
  });

  it('sem chave responde 401', async () => {
    const mundo = await criarMundoV1();
    mundos.push(mundo);
    const ids = await finalizarComArtefatos(mundo);
    const res = await mundo.app.inject({ method: 'GET', url: `/v1/documentos/${ids[0]}` });
    expect(res.statusCode).toBe(401);
  });
});
