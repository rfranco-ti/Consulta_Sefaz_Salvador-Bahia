import { rmSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registrarDocumentacao } from '../../src/app/plugins/documentacao.js';
import type { ServicoExecucoes } from '../../src/app/routes/execucoes.js';
import { DocumentosRepository, ExecucoesRepository } from '../../src/database/index.js';
import type {
  ArtefatosOpcao,
  ExecucaoResposta,
} from '../../src/modules/automation/automation.types.js';
import {
  criarMundoV1,
  fecharMundoV1,
  type MundoV1,
  type OpcoesMundoV1,
} from './v1-helpers.js';

const CNPJ_SEED_PDF_PRINT = '12345678000190';
const CNPJ_SEM_ARTEFATOS = '98765432000198';
const CNPJ_PENDENTE = '11122233344455';
const CNPJ_EXPIRADO = '22233344455566';
const CNPJ_NUNCA_GERADO = '33344455566677';
const CNPJ_POST = '44455566677788';
const CNPJ_SLUG = '55566677788899';
const CNPJ_FALHA = '66677788899900';

const PDF = Buffer.from('conteudo-pdf-teste');
const PRINT = Buffer.from('conteudo-print-teste');

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

async function semearSucesso(
  mundo: MundoV1,
  opcoes: {
    cnpj: string;
    tipo?: 'sefaz-bahia' | 'ficha-cadastral';
    artefatos?: ArtefatosOpcao;
    comPdf?: boolean;
    comPrint?: boolean;
  },
): Promise<{ id: string; resposta: ExecucaoResposta }> {
  const criada = await mundo.servico.iniciar({
    tipo: opcoes.tipo ?? 'sefaz-bahia',
    params: { cnpj: opcoes.cnpj },
    artefatos: opcoes.artefatos ?? 'ambos',
    inline: false,
    forceRefresh: false,
    apiKeyId: mundo.chaveA,
  });
  new ExecucoesRepository(mundo.tmp.banco).reservarProximaPendente();
  const resposta = await mundo.servico.finalizar(criada.execucaoId, {
    sucesso: true,
    dados: { situacao: 'ativa' },
    ...(opcoes.comPdf === false ? {} : { pdfBase64: PDF.toString('base64') }),
    ...(opcoes.comPrint === false ? {} : { printBase64: PRINT.toString('base64') }),
  });
  return { id: criada.execucaoId, resposta };
}

function linhaExecucao(mundo: MundoV1, id: string): { payload: string; payloadBruto: string } {
  const linha = mundo.tmp.banco
    .prepare<[string], { payload: string; payload_bruto: string }>(
      'SELECT payload, payload_bruto FROM execucoes WHERE id = ?',
    )
    .get(id);
  if (linha === undefined) {
    throw new Error(`Execução não encontrada no banco: ${id}`);
  }
  return { payload: linha.payload, payloadBruto: linha.payload_bruto };
}

describe('GET /v1/consultas/:tipo com file (download binário opt-in)', () => {
  it('file=true no acerto devolve os mesmos bytes da execução original', async () => {
    const mundo = await montar();
    await semearSucesso(mundo, { cnpj: CNPJ_SEED_PDF_PRINT });

    const semArquivo = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_SEED_PDF_PRINT}`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    expect(semArquivo.statusCode).toBe(200);
    expect(semArquivo.json()).toMatchObject({ status: 'SUCCESS', cache: { hit: true } });

    const comArquivo = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_SEED_PDF_PRINT}&file=true`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    expect(comArquivo.statusCode).toBe(200);
    expect(comArquivo.headers['content-type']).toContain('application/pdf');
    expect(comArquivo.headers['content-disposition']).toMatch(/^attachment; filename="/);
    expect(comArquivo.rawPayload.equals(PDF)).toBe(true);
    expect(comArquivo.headers['x-execucao-id']).toMatch(/^exe_/);
    expect(comArquivo.headers['x-cache-hit']).toBe('true');
    expect(comArquivo.headers['x-cache-camada']).toBeDefined();
    expect(comArquivo.headers['x-cache-ttl-restante-seg']).toBeDefined();

    const documentos = (
      semArquivo.json() as { documentos: Array<{ id: string; contentType: string }> }
    ).documentos;
    const pdf = documentos.find((item) => item.contentType === 'application/pdf');
    expect(pdf).toBeDefined();
    const direto = await mundo.app.inject({
      method: 'GET',
      url: `/v1/documentos/${pdf?.id}`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    expect(direto.rawPayload.equals(comArquivo.rawPayload)).toBe(true);
  });

  it('file=pdf e file=print selecionam o documento certo', async () => {
    const mundo = await montar();
    await semearSucesso(mundo, { cnpj: CNPJ_SEED_PDF_PRINT });

    const pdf = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_SEED_PDF_PRINT}&file=pdf`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.rawPayload.equals(PDF)).toBe(true);

    const print = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_SEED_PDF_PRINT}&file=print`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    expect(print.statusCode).toBe(200);
    expect(print.headers['content-type']).toContain('image/jpeg');
    expect(print.rawPayload.equals(PRINT)).toBe(true);
  });

  it('file=true prefere o PDF quando ambos existem', async () => {
    const mundo = await montar();
    await semearSucesso(mundo, { cnpj: CNPJ_SEED_PDF_PRINT });

    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_SEED_PDF_PRINT}&file=true`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.equals(PDF)).toBe(true);
  });

  it('padrão e file=false devolvem JSON idêntico', async () => {
    const mundo = await montar();
    await semearSucesso(mundo, { cnpj: CNPJ_SEED_PDF_PRINT });

    const padrao = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_SEED_PDF_PRINT}`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    const desligado = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_SEED_PDF_PRINT}&file=false`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    expect(padrao.statusCode).toBe(200);
    expect(desligado.statusCode).toBe(200);
    expect(desligado.headers['content-type']).toContain('application/json');
    // Cada acerto gera uma execução sintética distinta; todo o resto do
    // envelope deve ser idêntico (mesma entrada de cache, mesmo shape).
    const corpoPadrao = padrao.json() as Record<string, unknown>;
    const corpoDesligado = desligado.json() as Record<string, unknown>;
    expect(corpoPadrao['execucaoId']).toMatch(/^exe_/);
    expect(corpoDesligado['execucaoId']).toMatch(/^exe_/);
    delete corpoPadrao['execucaoId'];
    delete corpoDesligado['execucaoId'];
    expect(corpoDesligado).toEqual(corpoPadrao);
  });

  it('file=xxx responde 400 VALIDATION_ERROR', async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_SEED_PDF_PRINT}&file=xxx`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()?.error?.code).toBe('VALIDATION_ERROR');
  });

  it('file não altera a chave de cache nem vaza para o payload', async () => {
    const mundo = await montar();
    await semearSucesso(mundo, { cnpj: CNPJ_SEED_PDF_PRINT });

    const semArquivo = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_SEED_PDF_PRINT}`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    const comArquivo = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_SEED_PDF_PRINT}&file=true`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    expect(semArquivo.json()).toMatchObject({ cache: { hit: true } });
    expect(comArquivo.statusCode).toBe(200);
    expect(comArquivo.headers['x-cache-hit']).toBe('true');

    for (const id of [
      (semArquivo.json() as { execucaoId: string }).execucaoId,
      String(comArquivo.headers['x-execucao-id']),
    ]) {
      const { payload, payloadBruto } = linhaExecucao(mundo, id);
      expect(payload).not.toContain('"file"');
      expect(payloadBruto).not.toContain('"file"');
      expect(Object.keys(JSON.parse(payloadBruto) as Record<string, unknown>)).not.toContain(
        'file',
      );
    }
    const brutoSem = linhaExecucao(
      mundo,
      (semArquivo.json() as { execucaoId: string }).execucaoId,
    ).payloadBruto;
    const brutoCom = linhaExecucao(mundo, String(comArquivo.headers['x-execucao-id']))
      .payloadBruto;
    expect(brutoCom).toBe(brutoSem);
  });

  it('entrada em cache sem artefatos + file=true dispara nova execução com ambos', async () => {
    const mundo = await montar();
    await semearSucesso(mundo, {
      cnpj: CNPJ_SEM_ARTEFATOS,
      artefatos: 'nenhum',
      comPdf: false,
      comPrint: false,
    });

    const semArquivo = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_SEM_ARTEFATOS}`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    expect(semArquivo.statusCode).toBe(200);
    expect(semArquivo.json()).toMatchObject({ cache: { hit: true }, documentos: [] });

    const comArquivo = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_SEM_ARTEFATOS}&file=true&wait=0`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    expect(comArquivo.statusCode).toBe(504);
    const detalhes = (
      comArquivo.json() as { error: { details: { execucaoId: string } } }
    ).error.details;
    expect(detalhes.execucaoId).toMatch(/^exe_/);
    const armazenado = JSON.parse(linhaExecucao(mundo, detalhes.execucaoId).payload) as {
      artefatos: string;
    };
    expect(armazenado.artefatos).toBe('ambos');

    new ExecucoesRepository(mundo.tmp.banco).reservarProximaPendente();
    await mundo.servico.finalizar(detalhes.execucaoId, {
      sucesso: true,
      dados: { situacao: 'ativa' },
      pdfBase64: PDF.toString('base64'),
      printBase64: PRINT.toString('base64'),
    });
    const depois = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_SEM_ARTEFATOS}&file=true&wait=0`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    expect(depois.statusCode).toBe(200);
    expect(depois.rawPayload.equals(PDF)).toBe(true);
  });

  it("artefatos=nenhum explícito + file=true responde 400", async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_SEM_ARTEFATOS}&artefatos=nenhum&file=true`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()?.error?.code).toBe('VALIDATION_ERROR');
  });

  it('falha do portal com file mantém o mapeamento de erro', async () => {
    const saida: ExecucaoResposta = {
      execucaoId: 'exe_falha',
      status: 'FAILED',
      error: { code: 'EXTERNAL_SERVICE_ERROR', message: 'Portal fora do ar' },
    };
    const stub: ServicoExecucoes = {
      iniciar: async () => saida,
      consultarSincrona: async () => saida,
      consultar: async () => saida,
      cancelar: async () => undefined,
    };
    const mundo = await montar({ servico: stub });
    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_FALHA}&file=true`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: { code: 'EXTERNAL_SERVICE_ERROR', message: 'Portal fora do ar' },
    });
  });
});

describe('GET /v1/:slug com file equivale ao alias', () => {
  it('slug e alias devolvem os mesmos bytes', async () => {
    const mundo = await montar();
    await semearSucesso(mundo, { cnpj: CNPJ_SLUG, tipo: 'ficha-cadastral' });

    const viaSlug = await mundo.app.inject({
      method: 'GET',
      url: `/v1/ficha-cadastral-resumida?cnpj=${CNPJ_SLUG}&file=true`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    const viaAlias = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/ficha-cadastral?cnpj=${CNPJ_SLUG}&file=true`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    expect(viaSlug.statusCode).toBe(200);
    expect(viaAlias.statusCode).toBe(200);
    expect(viaSlug.headers['content-type']).toContain('application/pdf');
    expect(viaSlug.rawPayload.equals(viaAlias.rawPayload)).toBe(true);
    expect(viaSlug.rawPayload.equals(PDF)).toBe(true);
  });
});

describe('POST /v1/automacoes/:tipo com file', () => {
  it('file no corpo devolve o binário no acerto de cache', async () => {
    const mundo = await montar();
    await semearSucesso(mundo, { cnpj: CNPJ_POST });

    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia',
      headers: { 'x-api-key': mundo.tokenB },
      payload: { cnpj: CNPJ_POST, file: 'pdf' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="/);
    expect(res.rawPayload.equals(PDF)).toBe(true);
    expect(res.headers['x-cache-hit']).toBe('true');
  });

  it('file na querystring também vale no POST', async () => {
    const mundo = await montar();
    await semearSucesso(mundo, { cnpj: CNPJ_POST });

    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia?file=print',
      headers: { 'x-api-key': mundo.tokenB },
      payload: { cnpj: CNPJ_POST },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.rawPayload.equals(PRINT)).toBe(true);
  });

  it('file inválido no corpo responde 400', async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_POST, file: 'zip' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()?.error?.code).toBe('VALIDATION_ERROR');
  });

  it("artefatos=nenhum explícito + file=true responde 400", async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_POST, artefatos: 'nenhum', file: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()?.error?.code).toBe('VALIDATION_ERROR');
  });

  it('PENDING + file=true mantém JSON 202 e implica ambos', async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia?wait=0',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_PENDENTE, file: true },
    });
    expect(res.statusCode).toBe(202);
    expect(res.headers['content-type']).toContain('application/json');
    const corpo = res.json() as { execucaoId: string; status: string };
    expect(corpo.status).toBe('PENDING');
    const armazenado = JSON.parse(linhaExecucao(mundo, corpo.execucaoId).payload) as {
      artefatos: string;
    };
    expect(armazenado.artefatos).toBe('ambos');
  });
});

describe('GET /v1/execucoes/:id com file', () => {
  it('devolve o binário e preserva o JSON bruto sem file', async () => {
    const mundo = await montar();
    const { id } = await semearSucesso(mundo, { cnpj: CNPJ_SEED_PDF_PRINT });

    const cru = await mundo.app.inject({
      method: 'GET',
      url: `/v1/execucoes/${id}`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(cru.statusCode).toBe(200);
    expect(cru.json()).toMatchObject({ execucaoId: id, status: 'SUCCESS' });

    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/execucoes/${id}?file=pdf`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="/);
    expect(res.rawPayload.equals(PDF)).toBe(true);
    expect(res.headers['x-execucao-id']).toBe(id);
    expect(res.headers['x-cache-hit']).toBe('false');
  });

  it('artefato ausente no disco responde 410 ARQUIVO_EXPIRADO', async () => {
    const mundo = await montar();
    const { id, resposta } = await semearSucesso(mundo, { cnpj: CNPJ_SEED_PDF_PRINT });
    const pdf = (resposta.resultado?.documentos ?? []).find(
      (item) => item.contentType === 'application/pdf',
    );
    expect(pdf).toBeDefined();
    const registro = new DocumentosRepository(mundo.tmp.banco).buscarPorId(pdf?.id ?? '');
    expect(registro).not.toBeNull();
    rmSync(join(mundo.armazenamento, registro?.caminho ?? ''));

    const direto = await mundo.app.inject({
      method: 'GET',
      url: `/v1/execucoes/${id}?file=pdf`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(direto.statusCode).toBe(410);
    expect(direto.json()?.error?.code).toBe('ARQUIVO_EXPIRADO');
    expect(String(direto.json()?.error?.details?.hint ?? '')).toMatch(/forceRefresh/);

    const viaCache = await mundo.app.inject({
      method: 'GET',
      url: `/v1/consultas/sefaz-bahia?cnpj=${CNPJ_SEED_PDF_PRINT}&file=pdf`,
      headers: { 'x-api-key': mundo.tokenB },
    });
    expect(viaCache.statusCode).toBe(410);
    expect(viaCache.json()?.error?.code).toBe('ARQUIVO_EXPIRADO');
  });

  it('linha expirada responde 410 ARQUIVO_EXPIRADO', async () => {
    const mundo = await montar();
    const { id, resposta } = await semearSucesso(mundo, { cnpj: CNPJ_EXPIRADO });
    const pdf = (resposta.resultado?.documentos ?? []).find(
      (item) => item.contentType === 'application/pdf',
    );
    expect(pdf).toBeDefined();
    mundo.tmp.banco
      .prepare<[string, string]>('UPDATE documentos SET expira_em = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', pdf?.id ?? '');

    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/execucoes/${id}?file=pdf`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json()?.error?.code).toBe('ARQUIVO_EXPIRADO');
  });

  it('nunca gerado responde 404 NOT_FOUND com dica', async () => {
    const mundo = await montar();
    const { id } = await semearSucesso(mundo, {
      cnpj: CNPJ_NUNCA_GERADO,
      artefatos: 'nenhum',
      comPdf: false,
      comPrint: false,
    });

    const res = await mundo.app.inject({
      method: 'GET',
      url: `/v1/execucoes/${id}?file=true`,
      headers: { 'x-api-key': mundo.tokenA },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()?.error?.code).toBe('NOT_FOUND');
    expect(String(res.json()?.error?.details?.hint ?? '')).not.toBe('');
  });
});

describe('documentação do parâmetro file', () => {
  it('GET /docs/json expõe o esquema File', async () => {
    const app = Fastify({ logger: false });
    try {
      await registrarDocumentacao(app, { versao: '0.0.0-file-teste' });
      const res = await app.inject({ method: 'GET', url: '/docs/json' });
      expect(res.statusCode).toBe(200);
      const documento = res.json() as {
        components: { schemas: Record<string, Record<string, unknown>> };
      };
      expect(documento.components.schemas['File']).toMatchObject({
        type: 'string',
        enum: ['true', 'false', 'pdf', 'print'],
      });
      expect(documento.components.schemas['Artefatos']).toEqual({
        type: 'string',
        enum: ['nenhum', 'pdf', 'print', 'ambos'],
      });
    } finally {
      await app.close();
    }
  });
});
