import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { FastifyReply } from 'fastify';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { responderExecucao } from '../../src/app/routes/execucoes.js';
import { cacheConfig } from '../../src/config/cache.js';
import { DocumentosRepository } from '../../src/database/index.js';
import { ExecucoesRepository } from '../../src/database/index.js';
import { CacheRepository } from '../../src/database/repositories/cache.repository.js';
import { CacheConsultas, montarChaveCache } from '../../src/modules/automation/automation.cache.js';
import { AutomationService } from '../../src/modules/automation/automation.service.js';
import type { BrowserSession } from '../../src/modules/browser/browser.types.js';
import { limparExecutores, registrarExecutor } from '../../src/modules/jobs/executor.js';
import { WorkerFila } from '../../src/modules/jobs/job.worker.js';
import { obterCanalProgresso } from '../../src/modules/jobs/progresso.js';
import type { IniciarExecucaoInput } from '../../src/modules/automation/automation.types.js';
import { NotFoundError } from '../../src/shared/errors/index.js';
import { criarBancoTemporario, criarChaveApi } from './database-helpers.js';

const TIPO = 'sefaz-bahia' as const;
const CNPJ = '12345678000190';
const PDF_B64 = Buffer.from('pdf-producao').toString('base64');
const PRINT_B64 = Buffer.from('print-producao').toString('base64');

function sessaoFalsa(): BrowserSession {
  return {
    browser: {},
    context: {},
    page: {},
    liberar: async () => undefined,
  } as unknown as BrowserSession;
}

interface Mundo {
  banco: Database.Database;
  servico: AutomationService;
  cache: CacheConsultas;
  worker: WorkerFila;
  armazenamento: string;
  chaveA: string;
  chaveB: string;
  chaveC: string;
  limpar: () => void;
}

function montarMundo(situacao: { valor: string }): Mundo {
  const tmp = criarBancoTemporario();
  const chaveA = criarChaveApi(tmp.banco).id;
  const chaveB = criarChaveApi(tmp.banco).id;
  const chaveC = criarChaveApi(tmp.banco).id;
  const armazenamento = mkdtempSync(join(tmpdir(), 'artefatos-producao-'));
  const cache = new CacheConsultas({ banco: tmp.banco });
  const servico = new AutomationService({
    banco: tmp.banco,
    cache,
    diretorioArmazenamento: armazenamento,
  });
  const worker = new WorkerFila({
    banco: tmp.banco,
    criarSessao: async () => sessaoFalsa(),
    esperar: async () => undefined,
    backoffMs: () => 0,
    intervaloVarreduraMs: 0,
    logger: pino({ level: 'silent' }),
    aoConcluir: async (execucaoId, resultado, duracaoMs) => {
      await servico.finalizar(execucaoId, resultado, duracaoMs);
    },
  });
  registrarExecutor(TIPO, async () => ({
    sucesso: true,
    dados: { situacao: situacao.valor },
    pdfBase64: PDF_B64,
    printBase64: PRINT_B64,
  }));
  return {
    banco: tmp.banco,
    servico,
    cache,
    worker,
    armazenamento,
    chaveA,
    chaveB,
    chaveC,
    limpar: () => {
      tmp.limpar();
      rmSync(armazenamento, { recursive: true, force: true });
    },
  };
}

function entrada(apiKeyId: string, parcial: Partial<IniciarExecucaoInput> = {}): IniciarExecucaoInput {
  return {
    tipo: TIPO,
    params: { cnpj: CNPJ },
    artefatos: 'ambos',
    inline: false,
    forceRefresh: false,
    apiKeyId,
    ...parcial,
  };
}

beforeEach(() => {
  limparExecutores();
  obterCanalProgresso().limpar();
});

afterEach(() => {
  limparExecutores();
  obterCanalProgresso().limpar();
});

describe('caminho de produção worker -> finalizar', () => {
  it('persiste arquivos, documentos, urls, inline e remove os blobs do resultado', async () => {
    const mundo = montarMundo({ valor: 'ativa' });
    try {
      const eventos: string[] = [];
      const criada = await mundo.servico.iniciar(entrada(mundo.chaveA));
      obterCanalProgresso().observar(criada.execucaoId, (evento) => {
        eventos.push(evento.status);
      });
      const final = await mundo.worker.executarProxima();
      expect(final?.status).toBe('SUCCESS');

      const arquivos = readdirSync(join(mundo.armazenamento, criada.execucaoId)).sort();
      expect(arquivos).toHaveLength(2);
      expect(arquivos.map((nome) => nome.split('.').pop()).sort()).toEqual(['jpg', 'pdf']);

      const docs = new DocumentosRepository(mundo.banco).listarPorExecucao(criada.execucaoId);
      expect(docs).toHaveLength(2);

      const linha = new ExecucoesRepository(mundo.banco).buscarPorId(criada.execucaoId);
      const resultado = JSON.parse(linha?.resultado ?? '{}') as Record<string, unknown>;
      expect(resultado['pdfBase64']).toBeUndefined();
      expect(resultado['printBase64']).toBeUndefined();
      expect(resultado).toMatchObject({ sucesso: true, dados: { situacao: 'ativa' } });

      const resposta = await mundo.servico.consultar(criada.execucaoId, mundo.chaveA);
      expect(resposta.status).toBe('SUCCESS');
      const urls = (resposta.resultado?.documentos ?? []).map((d) => d.url).sort();
      expect(urls).toHaveLength(2);
      for (const url of urls) {
        expect(url).toMatch(/^\/v1\/documentos\/doc_/);
      }

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
      await responderExecucao(reply, resposta, {
        inline: true,
        documentos: new DocumentosRepository(mundo.banco),
        diretorioArmazenamento: mundo.armazenamento,
      });
      expect(capturado.statusCode).toBe(200);
      expect(capturado.payload?.['pdfBase64']).toBe(PDF_B64);
      expect(capturado.payload?.['printBase64']).toBe(PRINT_B64);
      expect(capturado.payload?.['documentos']).toHaveLength(2);

      expect(eventos).toContain('SUCCESS');
      expect(final?.attempts).toBeGreaterThan(0);
    } finally {
      mundo.limpar();
    }
  });

  it('acerto de cache devolve os mesmos documentos e concede acesso só ao solicitante', async () => {
    const mundo = montarMundo({ valor: 'ativa' });
    try {
      const primeira = await mundo.servico.iniciar(entrada(mundo.chaveA));
      await mundo.worker.executarProxima();
      const original = await mundo.servico.consultar(primeira.execucaoId, mundo.chaveA);
      const urlsOriginais = (original.resultado?.documentos ?? []).map((d) => d.url).sort();
      expect(urlsOriginais).toHaveLength(2);

      const acerto = await mundo.servico.iniciar(entrada(mundo.chaveB));
      expect(acerto.status).toBe('SUCCESS');
      expect(acerto.cache).toMatchObject({ hit: true });
      const urlsAcerto = (acerto.resultado?.documentos ?? []).map((d) => d.url).sort();
      expect(urlsAcerto).toEqual(urlsOriginais);

      await expect(
        mundo.servico.consultar(primeira.execucaoId, mundo.chaveB),
      ).resolves.toMatchObject({ status: 'SUCCESS' });
      await expect(
        mundo.servico.consultar(acerto.execucaoId, mundo.chaveB),
      ).resolves.toMatchObject({ status: 'SUCCESS' });
      await expect(mundo.servico.consultar(primeira.execucaoId, mundo.chaveC)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    } finally {
      mundo.limpar();
    }
  });

  it('forceRefresh substitui o valor do cache', async () => {
    const situacao = { valor: 'ativa-1' };
    const mundo = montarMundo(situacao);
    try {
      const primeira = await mundo.servico.iniciar(entrada(mundo.chaveA));
      await mundo.worker.executarProxima();
      expect((await mundo.servico.consultar(primeira.execucaoId, mundo.chaveA)).resultado?.dados).toEqual({
        situacao: 'ativa-1',
      });

      situacao.valor = 'ativa-2';
      const forcada = await mundo.servico.iniciar(entrada(mundo.chaveB, { forceRefresh: true }));
      expect(forcada.status).toBe('PENDING');
      expect(forcada.cache).toMatchObject({ hit: false });
      await mundo.worker.executarProxima();

      const depois = await mundo.servico.iniciar(entrada(mundo.chaveA));
      expect(depois.status).toBe('SUCCESS');
      expect(depois.cache).toMatchObject({ hit: true });
      expect(depois.resultado?.dados).toEqual({ situacao: 'ativa-2' });
    } finally {
      mundo.limpar();
    }
  });

  it('sondagem de execução antiga não ressuscita o cache', async () => {
    const mundo = montarMundo({ valor: 'ativa' });
    try {
      const ttlMs = cacheConfig(TIPO).ttlMs;
      const primeira = await mundo.servico.iniciar(entrada(mundo.chaveA));
      await mundo.worker.executarProxima();
      const chave = montarChaveCache(TIPO, { cnpj: CNPJ });
      expect(new CacheRepository(mundo.banco).obter(chave)).not.toBeNull();

      mundo.cache.invalidar(TIPO, { cnpj: CNPJ });
      expect(new CacheRepository(mundo.banco).obter(chave)).toBeNull();
      const servicoFuturo = new AutomationService({
        banco: mundo.banco,
        diretorioArmazenamento: mundo.armazenamento,
        agora: () => Date.now() + ttlMs + 60_000,
      });
      await servicoFuturo.consultar(primeira.execucaoId, mundo.chaveA);
      expect(new CacheConsultas({ banco: mundo.banco }).ler(TIPO, { cnpj: CNPJ })).toBeNull();

      const lida = await mundo.servico.consultar(primeira.execucaoId, mundo.chaveA);
      expect(lida.status).toBe('SUCCESS');
      const leitura = new CacheConsultas({ banco: mundo.banco }).ler(TIPO, { cnpj: CNPJ });
      expect(leitura?.dados).toMatchObject({ sucesso: true, dados: { situacao: 'ativa' } });
    } finally {
      mundo.limpar();
    }
  });

  it('documentos e cache compartilham o mesmo instante de expiração', async () => {
    const mundo = montarMundo({ valor: 'ativa' });
    try {
      const primeira = await mundo.servico.iniciar(entrada(mundo.chaveA));
      await mundo.worker.executarProxima();
      const docs = new DocumentosRepository(mundo.banco).listarPorExecucao(primeira.execucaoId);
      expect(docs).toHaveLength(2);
      const chave = montarChaveCache(TIPO, { cnpj: CNPJ });
      const linha = mundo.banco
        .prepare<[string], { expira_em: string }>('SELECT expira_em FROM cache_consultas WHERE chave = ?')
        .get(chave);
      expect(linha).toBeDefined();
      for (const doc of docs) {
        expect(doc.expiraEm).not.toBeNull();
        expect(doc.expiraEm).toBe(linha?.expira_em);
      }
    } finally {
      mundo.limpar();
    }
  });
});
