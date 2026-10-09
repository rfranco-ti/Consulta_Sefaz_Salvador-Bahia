import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { FastifyReply } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  responderExecucao,
  responderExecucaoComArquivo,
} from '../../src/app/routes/execucoes.js';
import { DocumentosRepository, ExecucoesRepository } from '../../src/database/index.js';
import { CacheConsultas } from '../../src/modules/automation/automation.cache.js';
import { AutomationService } from '../../src/modules/automation/automation.service.js';
import type { IniciarExecucaoInput } from '../../src/modules/automation/automation.types.js';
import { CanalProgresso } from '../../src/modules/jobs/progresso.js';
import { criarBancoTemporario, criarChaveApi } from './database-helpers.js';

const CNPJ = '12345678000190';
const PDF_B64 = Buffer.from('pdf-aviso').toString('base64');
const PRINT_B64 = Buffer.from('print-aviso').toString('base64');

interface Mundo {
  banco: Database.Database;
  servico: AutomationService;
  cache: CacheConsultas;
  chaveA: string;
  chaveB: string;
  chaveC: string;
  armazenamento: string;
  limpar: () => void;
}

function montarMundo(): Mundo {
  const tmp = criarBancoTemporario();
  const chaveA = criarChaveApi(tmp.banco).id;
  const chaveB = criarChaveApi(tmp.banco).id;
  const chaveC = criarChaveApi(tmp.banco).id;
  const armazenamento = mkdtempSync(join(tmpdir(), 'avisos-teste-'));
  const cache = new CacheConsultas({ banco: tmp.banco });
  const servico = new AutomationService({
    banco: tmp.banco,
    cache,
    canal: new CanalProgresso(),
    diretorioArmazenamento: armazenamento,
  });
  return {
    banco: tmp.banco,
    servico,
    cache,
    chaveA,
    chaveB,
    chaveC,
    armazenamento,
    limpar: () => {
      tmp.limpar();
      rmSync(armazenamento, { recursive: true, force: true });
    },
  };
}

function entrada(apiKeyId: string, parcial: Partial<IniciarExecucaoInput> = {}): IniciarExecucaoInput {
  return {
    tipo: 'sefaz-bahia',
    params: { cnpj: CNPJ },
    artefatos: 'ambos',
    inline: false,
    forceRefresh: false,
    apiKeyId,
    ...parcial,
  };
}

function reservarComoRunning(banco: Database.Database): void {
  new ExecucoesRepository(banco).reservarProximaPendente();
}

function replyJson(): {
  reply: FastifyReply;
  capturado: { statusCode?: number; payload?: Record<string, unknown> };
} {
  const capturado: { statusCode?: number; payload?: Record<string, unknown> } = {};
  const reply = {
    code(status: number) {
      capturado.statusCode = status;
      return this;
    },
    send(payload: Record<string, unknown>) {
      capturado.payload = payload;
      return this;
    },
  } as unknown as FastifyReply;
  return { reply, capturado };
}

beforeEach(() => {
  new CanalProgresso().limpar();
});

afterEach(() => {
  new CanalProgresso().limpar();
});

describe('avisos de artefatos ausentes', () => {
  it('sintetiza aviso quando SUCESSO + ambos + zero documentos', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada(mundo.chaveA));
      reservarComoRunning(mundo.banco);
      const resposta = await mundo.servico.finalizar(criada.execucaoId, {
        sucesso: true,
        dados: { situacao: 'ativa' },
      });
      expect(resposta.status).toBe('SUCCESS');
      expect(resposta.resultado?.documentos ?? []).toHaveLength(0);
      expect(resposta.resultado?.avisos).toEqual([
        'Artefatos solicitados (pdf, print) não foram gerados nesta execução.',
      ]);
      // Persistido no enxuto de execucoes.resultado.
      const linha = new ExecucoesRepository(mundo.banco).buscarPorId(criada.execucaoId);
      const bruto = JSON.parse(linha?.resultado ?? '{}') as Record<string, unknown>;
      expect(bruto['avisos']).toEqual([
        'Artefatos solicitados (pdf, print) não foram gerados nesta execução.',
      ]);
    } finally {
      mundo.limpar();
    }
  });

  it('deriva os nomes do aviso a partir do que foi pedido (pdf / print)', async () => {
    for (const artefatos of ['pdf', 'print'] as const) {
      const mundo = montarMundo();
      try {
        const criada = await mundo.servico.iniciar(entrada(mundo.chaveA, { artefatos }));
        reservarComoRunning(mundo.banco);
        const resposta = await mundo.servico.finalizar(criada.execucaoId, {
          sucesso: true,
          dados: { situacao: 'ativa' },
        });
        expect(resposta.resultado?.avisos).toEqual([
          `Artefatos solicitados (${artefatos}) não foram gerados nesta execução.`,
        ]);
      } finally {
        mundo.limpar();
      }
    }
  });

  it('não emite aviso quando documentos foram produzidos (campo ausente)', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada(mundo.chaveA));
      reservarComoRunning(mundo.banco);
      const resposta = await mundo.servico.finalizar(criada.execucaoId, {
        sucesso: true,
        dados: { situacao: 'ativa' },
        pdfBase64: PDF_B64,
        printBase64: PRINT_B64,
      });
      expect(resposta.status).toBe('SUCCESS');
      expect(resposta.resultado?.documentos).toHaveLength(2);
      expect(resposta.resultado).not.toHaveProperty('avisos');
      const linha = new ExecucoesRepository(mundo.banco).buscarPorId(criada.execucaoId);
      const bruto = JSON.parse(linha?.resultado ?? '{}') as Record<string, unknown>;
      expect(bruto).not.toHaveProperty('avisos');
    } finally {
      mundo.limpar();
    }
  });

  it("não emite aviso quando artefatos='nenhum'", async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada(mundo.chaveA, { artefatos: 'nenhum' }));
      reservarComoRunning(mundo.banco);
      const resposta = await mundo.servico.finalizar(criada.execucaoId, {
        sucesso: true,
        dados: { situacao: 'ativa' },
      });
      expect(resposta.status).toBe('SUCCESS');
      expect(resposta.resultado).not.toHaveProperty('avisos');
    } finally {
      mundo.limpar();
    }
  });

  it('não emite aviso em execução FAILED', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada(mundo.chaveA));
      reservarComoRunning(mundo.banco);
      const resposta = await mundo.servico.falhar(criada.execucaoId, new Error('Portal fora do ar'));
      expect(resposta.status).toBe('FAILED');
      expect(resposta).not.toHaveProperty('resultado');
      expect(resposta).not.toHaveProperty('avisos');
      const lida = await mundo.servico.consultar(criada.execucaoId, mundo.chaveA);
      expect(lida.status).toBe('FAILED');
      expect(lida).not.toHaveProperty('resultado');
    } finally {
      mundo.limpar();
    }
  });

  it('não emite aviso no achado negativo (sucesso=false)', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada(mundo.chaveA));
      reservarComoRunning(mundo.banco);
      const resposta = await mundo.servico.finalizar(criada.execucaoId, {
        sucesso: false,
        dados: { cnpjBuscado: CNPJ },
        mensagem: 'Inscrição não encontrada',
      });
      expect(resposta.status).toBe('SUCCESS');
      expect(resposta.resultado?.sucesso).toBe(false);
      expect(resposta.resultado).not.toHaveProperty('avisos');
    } finally {
      mundo.limpar();
    }
  });

  it('o aviso sobrevive a um GET posterior (consultar)', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada(mundo.chaveA));
      reservarComoRunning(mundo.banco);
      await mundo.servico.finalizar(criada.execucaoId, {
        sucesso: true,
        dados: { situacao: 'ativa' },
      });
      const lida = await mundo.servico.consultar(criada.execucaoId, mundo.chaveA);
      expect(lida.status).toBe('SUCCESS');
      expect(lida.resultado?.avisos).toEqual([
        'Artefatos solicitados (pdf, print) não foram gerados nesta execução.',
      ]);
    } finally {
      mundo.limpar();
    }
  });

  it('acerto de cache reexpõe o aviso (decisão: avisos vão ao cache)', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada(mundo.chaveA));
      reservarComoRunning(mundo.banco);
      await mundo.servico.finalizar(criada.execucaoId, {
        sucesso: true,
        dados: { situacao: 'ativa' },
      });
      // O payload de cache carrega os avisos.
      const leitura = new CacheConsultas({ banco: mundo.banco }).ler('sefaz-bahia', {
        cnpj: CNPJ,
      });
      expect(leitura?.dados).toMatchObject({
        avisos: ['Artefatos solicitados (pdf, print) não foram gerados nesta execução.'],
      });
      // O acerto com os mesmos artefatos reexpõe o aviso.
      const acerto = await mundo.servico.iniciar(entrada(mundo.chaveB));
      expect(acerto.status).toBe('SUCCESS');
      expect(acerto.cache).toMatchObject({ hit: true });
      expect(acerto.resultado?.avisos).toEqual([
        'Artefatos solicitados (pdf, print) não foram gerados nesta execução.',
      ]);
    } finally {
      mundo.limpar();
    }
  });

  it('propagarSucessoParaCache repõe os avisos ao ressuscitar o cache', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada(mundo.chaveA));
      reservarComoRunning(mundo.banco);
      await mundo.servico.finalizar(criada.execucaoId, {
        sucesso: true,
        dados: { situacao: 'ativa' },
      });
      const cache = mundo.cache;
      cache.invalidar('sefaz-bahia', { cnpj: CNPJ });
      expect(cache.ler('sefaz-bahia', { cnpj: CNPJ })).toBeNull();
      // Sondar a execução antiga repõe o cache com os mesmos avisos de finalizar.
      await mundo.servico.consultar(criada.execucaoId, mundo.chaveA);
      const reposta = cache.ler('sefaz-bahia', { cnpj: CNPJ });
      expect(reposta?.dados).toMatchObject({
        avisos: ['Artefatos solicitados (pdf, print) não foram gerados nesta execução.'],
      });
    } finally {
      mundo.limpar();
    }
  });

  it("acerto com artefatos='nenhum' suprime o aviso herdado do cache", async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada(mundo.chaveA));
      reservarComoRunning(mundo.banco);
      await mundo.servico.finalizar(criada.execucaoId, {
        sucesso: true,
        dados: { situacao: 'ativa' },
      });
      const acerto = await mundo.servico.iniciar(entrada(mundo.chaveB, { artefatos: 'nenhum' }));
      expect(acerto.status).toBe('SUCCESS');
      expect(acerto.cache).toMatchObject({ hit: true });
      expect(acerto.resultado).not.toHaveProperty('avisos');
    } finally {
      mundo.limpar();
    }
  });

  it('responderExecucao inclui avisos no JSON e omite quando ausente', async () => {
    const mundo = montarMundo();
    try {
      // Com aviso.
      const semArtefatos = await mundo.servico.iniciar(entrada(mundo.chaveA));
      reservarComoRunning(mundo.banco);
      const respAviso = await mundo.servico.finalizar(semArtefatos.execucaoId, {
        sucesso: true,
        dados: { situacao: 'ativa' },
      });
      const { reply: reply1, capturado: cap1 } = replyJson();
      await responderExecucao(reply1, respAviso, {
        inline: false,
        documentos: new DocumentosRepository(mundo.banco),
        diretorioArmazenamento: mundo.armazenamento,
      });
      expect(cap1.statusCode).toBe(200);
      expect(cap1.payload).toHaveProperty('avisos', [
        'Artefatos solicitados (pdf, print) não foram gerados nesta execução.',
      ]);

      // Sem aviso: campo omitido por completo.
      const comDocs = await mundo.servico.iniciar(
        entrada(mundo.chaveB, { params: { cnpj: '98765432000198' } }),
      );
      reservarComoRunning(mundo.banco);
      const respOk = await mundo.servico.finalizar(comDocs.execucaoId, {
        sucesso: true,
        dados: { situacao: 'ativa' },
        pdfBase64: PDF_B64,
      });
      expect(respOk.resultado).not.toHaveProperty('avisos');
      const { reply: reply2, capturado: cap2 } = replyJson();
      await responderExecucao(reply2, respOk, {
        inline: false,
        documentos: new DocumentosRepository(mundo.banco),
        diretorioArmazenamento: mundo.armazenamento,
      });
      expect(cap2.statusCode).toBe(200);
      expect(cap2.payload).not.toHaveProperty('avisos');
      expect(cap2.payload).toHaveProperty('documentos');
    } finally {
      mundo.limpar();
    }
  });

  it('resposta binária file=true não carrega campo avisos (bytes e headers intactos)', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada(mundo.chaveA));
      reservarComoRunning(mundo.banco);
      await mundo.servico.finalizar(criada.execucaoId, {
        sucesso: true,
        dados: { situacao: 'ativa' },
        pdfBase64: PDF_B64,
        printBase64: PRINT_B64,
      });
      const resposta = await mundo.servico.consultar(criada.execucaoId, mundo.chaveA);
      expect(resposta.resultado).not.toHaveProperty('avisos');

      const headers: Record<string, string> = {};
      let bytes: unknown;
      const reply = {
        header(nome: string, valor: string) {
          headers[nome] = valor;
          return this;
        },
        async send(payload: unknown) {
          bytes = payload;
          return this;
        },
      } as unknown as FastifyReply;
      await responderExecucaoComArquivo(reply, resposta, {
        file: 'principal',
        inline: false,
        documentos: new DocumentosRepository(mundo.banco),
        diretorioArmazenamento: mundo.armazenamento,
      });
      expect(Buffer.isBuffer(bytes)).toBe(true);
      expect((bytes as Buffer).toString()).toBe('pdf-aviso');
      expect(headers['content-type']).toBe('application/pdf');
      expect(headers['content-disposition']).toMatch(/attachment; filename="/);
      expect(headers['x-execucao-id']).toBe(criada.execucaoId);
      // Caminho binário não é envelope JSON: nenhum campo avisos serializado.
      expect(bytes).not.toHaveProperty('avisos');
    } finally {
      mundo.limpar();
    }
  });
});
