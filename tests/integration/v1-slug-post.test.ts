import { afterEach, describe, expect, it } from 'vitest';
import type { ServicoExecucoes } from '../../src/app/routes/execucoes.js';
import { ExecucoesRepository } from '../../src/database/index.js';
import type {
  ConsultarSincronaInput,
  ExecucaoResposta,
  IniciarExecucaoInput,
} from '../../src/modules/automation/automation.types.js';
import {
  criarMundoV1,
  fecharMundoV1,
  type MundoV1,
  type OpcoesMundoV1,
} from './v1-helpers.js';

const CNPJ_FICHA = '12345678000190';
const CNPJ_SEFAZ = '98765432000198';
const CNPJ_NOVO = '11122233344455';
const CPF_SOCIO = '123.456.789-09';

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

interface EntradaVista {
  tipo: string;
  waitSeg?: number;
}

function stubCaptura(vistas: EntradaVista[]): ServicoExecucoes {
  const saida: ExecucaoResposta = {
    execucaoId: 'exe_slug',
    status: 'SUCCESS',
    resultado: { sucesso: true, dados: { situacao: 'ativa' } },
    cache: { hit: false },
  };
  const ver = (entrada: IniciarExecucaoInput | ConsultarSincronaInput): void => {
    vistas.push({
      tipo: entrada.tipo,
      ...('waitSeg' in entrada ? { waitSeg: entrada.waitSeg } : {}),
    });
  };
  return {
    iniciar: async (entrada) => {
      ver(entrada);
      return saida;
    },
    consultarSincrona: async (entrada) => {
      ver(entrada);
      return saida;
    },
    consultar: async () => saida,
    cancelar: async () => undefined,
  };
}

async function semearSucesso(
  mundo: MundoV1,
  tipo: 'sefaz-bahia' | 'ficha-cadastral',
  cnpj: string,
  artefatos: 'nenhum' | 'ambos' = 'nenhum',
): Promise<string> {
  const criada = await mundo.servico.iniciar({
    tipo,
    params: { cnpj },
    artefatos,
    inline: false,
    forceRefresh: false,
    apiKeyId: mundo.chaveA,
  });
  new ExecucoesRepository(mundo.tmp.banco).reservarProximaPendente();
  await mundo.servico.finalizar(
    criada.execucaoId,
    artefatos === 'ambos'
      ? {
          sucesso: true,
          dados: { situacao: 'ativa' },
          pdfBase64: Buffer.from('pdf-teste').toString('base64'),
          printBase64: Buffer.from('print-teste').toString('base64'),
        }
      : { sucesso: true, dados: { situacao: 'ativa' } },
  );
  return criada.execucaoId;
}

describe('POST /v1/automacoes/:tipo aceita slugs públicos', () => {
  it('slug resolve para o id interno no IniciarExecucaoInput', async () => {
    const vistas: EntradaVista[] = [];
    const mundo = await montar({ servico: stubCaptura(vistas) });
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/ficha-cadastral-resumida?wait=5',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_FICHA },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'SUCCESS', sucesso: true });
    expect(vistas).toEqual([{ tipo: 'ficha-cadastral', waitSeg: 5 }]);
  });

  it('id interno continua funcionando com resultado equivalente', async () => {
    const vistasSlug: EntradaVista[] = [];
    const vistasId: EntradaVista[] = [];
    const mundoSlug = await montar({ servico: stubCaptura(vistasSlug) });
    const viaSlug = await mundoSlug.app.inject({
      method: 'POST',
      url: '/v1/automacoes/ficha-cadastral-resumida?wait=5',
      headers: { 'x-api-key': mundoSlug.tokenA },
      payload: { cnpj: CNPJ_FICHA },
    });
    const mundoId = await montar({ servico: stubCaptura(vistasId) });
    const viaId = await mundoId.app.inject({
      method: 'POST',
      url: '/v1/automacoes/ficha-cadastral?wait=5',
      headers: { 'x-api-key': mundoId.tokenA },
      payload: { cnpj: CNPJ_FICHA },
    });
    expect(viaId.statusCode).toBe(200);
    expect(viaId.json()).toEqual(viaSlug.json());
    expect(vistasId).toEqual([{ tipo: 'ficha-cadastral', waitSeg: 5 }]);
  });

  it('o tipo persistido é o id interno quando a requisição usa o slug', async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/ficha-cadastral-resumida',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_NOVO },
    });
    expect(res.statusCode).toBe(202);
    const execucaoId = (res.json() as { execucaoId: string }).execucaoId;
    const linha = new ExecucoesRepository(mundo.tmp.banco).buscarPorId(execucaoId);
    expect(linha).not.toBeNull();
    expect(linha?.tipo).toBe('ficha-cadastral');
    expect(linha?.payload).toContain(CNPJ_NOVO);
  });

  it('slug e id interno compartilham a mesma entrada de cache', async () => {
    const mundo = await montar();
    await semearSucesso(mundo, 'ficha-cadastral', CNPJ_FICHA);
    const viaSlug = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/ficha-cadastral-resumida',
      headers: { 'x-api-key': mundo.tokenB },
      payload: { cnpj: CNPJ_FICHA },
    });
    const viaId = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/ficha-cadastral',
      headers: { 'x-api-key': mundo.tokenB },
      payload: { cnpj: CNPJ_FICHA },
    });
    expect(viaSlug.statusCode).toBe(200);
    expect(viaId.statusCode).toBe(200);
    expect(viaSlug.json()).toMatchObject({
      status: 'SUCCESS',
      sucesso: true,
      dados: { situacao: 'ativa' },
      cache: { hit: true },
    });
    // Mesma entrada de cache: o mesmo resultado semeado, independente da
    // grafia usada na URL.
    expect(viaId.json()).toMatchObject({
      status: 'SUCCESS',
      sucesso: true,
      dados: { situacao: 'ativa' },
      cache: { hit: true },
    });
  });

  it('valor desconhecido responde 400 VALIDATION_ERROR', async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/portal-fantasma',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_FICHA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()?.error?.code).toBe('VALIDATION_ERROR');
    expect(typeof res.json()?.error?.message).toBe('string');
  });

  it('slug com parâmetros de outro tipo não é posicional: cpf resolve sefaz-bahia-socio', async () => {
    const vistas: EntradaVista[] = [];
    const mundo = await montar({ servico: stubCaptura(vistas) });
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia-socio-por-cpf?wait=5',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cpf: CPF_SOCIO },
    });
    expect(res.statusCode).toBe(200);
    expect(vistas).toEqual([{ tipo: 'sefaz-bahia-socio', waitSeg: 5 }]);
  });

  it('slug valida contra o schema do tipo resolvido (cnpj no slug de sócio → 400)', async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia-socio-por-cpf',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_SEFAZ },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()?.error?.code).toBe('VALIDATION_ERROR');
  });

  it('tipos distintos não compartilham cache mesmo com o mesmo documento', async () => {
    const mundo = await montar();
    await semearSucesso(mundo, 'sefaz-bahia', CNPJ_SEFAZ);
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/ficha-cadastral-resumida',
      headers: { 'x-api-key': mundo.tokenB },
      payload: { cnpj: CNPJ_SEFAZ },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'PENDING', cache: { hit: false } });
  });

  it('slug no modo async padrão responde 202', async () => {
    const mundo = await montar();
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia-cadastro-cnpj',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { cnpj: CNPJ_NOVO },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'PENDING', cache: { hit: false } });
    const execucaoId = (res.json() as { execucaoId: string }).execucaoId;
    expect(new ExecucoesRepository(mundo.tmp.banco).buscarPorId(execucaoId)?.tipo).toBe(
      'sefaz-bahia',
    );
  });

  it('slug com ?wait responde 200 no acerto de cache', async () => {
    const mundo = await montar();
    await semearSucesso(mundo, 'sefaz-bahia', CNPJ_SEFAZ);
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/sefaz-bahia-cadastro-cnpj?wait=5',
      headers: { 'x-api-key': mundo.tokenB },
      payload: { cnpj: CNPJ_SEFAZ },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'SUCCESS', cache: { hit: true } });
  });

  it('slug com async:false usa a espera máxima', async () => {
    const vistas: EntradaVista[] = [];
    const mundo = await montar({ servico: stubCaptura(vistas) });
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/iptu-dados-cadastrais',
      headers: { 'x-api-key': mundo.tokenA },
      payload: { numeroIptu: '12345', async: false },
    });
    expect(res.statusCode).toBe(200);
    expect(vistas).toEqual([{ tipo: 'iptu-salvador', waitSeg: 60 }]);
  });

  it('slug com artefatos e file devolve o binário do cache', async () => {
    const mundo = await montar();
    await semearSucesso(mundo, 'ficha-cadastral', CNPJ_FICHA, 'ambos');
    const res = await mundo.app.inject({
      method: 'POST',
      url: '/v1/automacoes/ficha-cadastral-resumida?wait=5',
      headers: { 'x-api-key': mundo.tokenB },
      payload: { cnpj: CNPJ_FICHA, artefatos: 'ambos', file: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['x-cache-hit']).toBe('true');
    expect(res.rawPayload.equals(Buffer.from('pdf-teste'))).toBe(true);
  });
});
