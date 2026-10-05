import type Database from 'better-sqlite3';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TipoAutomacao } from '../../src/automations/registry.js';
import type { Execucao } from '../../src/database/index.js';
import { ExecucoesRepository } from '../../src/database/index.js';
import type { BrowserSession } from '../../src/modules/browser/browser.types.js';
import { limparExecutores, registrarExecutor } from '../../src/modules/jobs/executor.js';
import { WorkerFila } from '../../src/modules/jobs/job.worker.js';
import type { DepsExecutor } from '../../src/modules/jobs/job.types.js';
import { obterCanalProgresso } from '../../src/modules/jobs/progresso.js';
import { Semaforo } from '../../src/modules/jobs/semaphore.js';
import { BrowserError, TimeoutError } from '../../src/shared/errors/index.js';
import { criarBancoTemporario, criarChaveApi } from './database-helpers.js';

function sessaoFalsa(contador: { liberadas: number }): BrowserSession {
  return {
    browser: {},
    context: {},
    page: {},
    liberar: async () => {
      contador.liberadas += 1;
    },
  } as unknown as BrowserSession;
}

function montarBanco(): {
  banco: Database.Database;
  repo: ExecucoesRepository;
  apiKeyId: string;
  limpar: () => void;
} {
  const { banco, limpar } = criarBancoTemporario();
  const { id } = criarChaveApi(banco);
  return { banco, repo: new ExecucoesRepository(banco), apiKeyId: id, limpar };
}

function criarWorker(
  banco: Database.Database,
  parcial: {
    semaforo?: Semaforo;
    timeoutSemaforoMs?: number;
    criarSessao?: (portal: string) => Promise<BrowserSession>;
  } = {},
): WorkerFila {
  return new WorkerFila({
    banco,
    semaforo: parcial.semaforo,
    timeoutSemaforoMs: parcial.timeoutSemaforoMs,
    criarSessao: parcial.criarSessao ?? (async () => sessaoFalsa({ liberadas: 0 })),
    esperar: async () => undefined,
    intervaloSondagemMs: 5,
    intervaloVarreduraMs: 0,
    logger: pino({ level: 'silent' }),
  });
}

beforeEach(() => {
  limparExecutores();
  obterCanalProgresso().limpar();
});

afterEach(() => {
  limparExecutores();
  obterCanalProgresso().limpar();
});

describe('factory de sessões do worker', () => {
  it('executa executor de dois parâmetros mesmo passando deps', async () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    try {
      const worker = criarWorker(banco);
      registrarExecutor('sefaz-bahia', async () => ({ processada: true }));
      repo.inserir({ id: 'exe_deps_2p', tipo: 'sefaz-bahia', payload: '{}', payloadBruto: '{}', apiKeyId });
      const final = await worker.executarProxima();
      expect(final?.status).toBe('SUCCESS');
      expect(JSON.parse(final?.resultado ?? '')).toEqual({ processada: true });
    } finally {
      limpar();
    }
  });

  it('entrega factory ao executor que a declara', async () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    try {
      const worker = criarWorker(banco);
      let recebidas: DepsExecutor | undefined;
      registrarExecutor('sefaz-bahia', async (_execucao, _sessao, deps) => {
        recebidas = deps;
        return { processada: true };
      });
      repo.inserir({ id: 'exe_deps_3p', tipo: 'sefaz-bahia', payload: '{}', payloadBruto: '{}', apiKeyId });
      const final = await worker.executarProxima();
      expect(final?.status).toBe('SUCCESS');
      expect(typeof recebidas?.criarSessao).toBe('function');
    } finally {
      limpar();
    }
  });

  it('fábrica cria sessão isolada por portal e libera a primária pelo worker', async () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    try {
      const portais: string[] = [];
      const primarias = { liberadas: 0 };
      const filhas = { liberadas: 0 };
      const worker = criarWorker(banco, {
        criarSessao: async (portal: string) => {
          portais.push(portal);
          return portal === 'MULTI' ? sessaoFalsa(primarias) : sessaoFalsa(filhas);
        },
      });
      let sessoesDistintas = false;
      registrarExecutor('consulta-inscricoes', async (_execucao, primaria, deps) => {
        const estadual = await deps?.criarSessao('SEFAZ_BA');
        const municipal = await deps?.criarSessao('PREF_SALVADOR');
        sessoesDistintas =
          estadual !== undefined &&
          municipal !== undefined &&
          estadual !== municipal &&
          estadual !== primaria &&
          municipal !== primaria;
        await estadual?.liberar();
        await municipal?.liberar();
        return { sucesso: true };
      });
      repo.inserir({
        id: 'exe_deps_multi',
        tipo: 'consulta-inscricoes' as TipoAutomacao,
        payload: '{}',
        payloadBruto: '{}',
        apiKeyId,
      });
      const final = await worker.executarProxima();
      expect(final?.status).toBe('SUCCESS');
      expect(sessoesDistintas).toBe(true);
      expect(portais).toEqual(['MULTI', 'SEFAZ_BA', 'PREF_SALVADOR']);
      expect(filhas.liberadas).toBe(2);
      expect(primarias.liberadas).toBe(1);
    } finally {
      limpar();
    }
  });

  it('fábrica bloqueia segundo uso do mesmo portal até liberar', async () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    try {
      const semaforo = new Semaforo(5, 1);
      const worker = criarWorker(banco, { semaforo, timeoutSemaforoMs: 20 });
      let segundaBloqueada = false;
      let reutilizada = false;
      registrarExecutor('ficha-cadastral', async (_execucao, _sessao, deps) => {
        const primeira = await deps?.criarSessao('SEFAZ_BA');
        try {
          await deps?.criarSessao('SEFAZ_BA');
        } catch (erro) {
          segundaBloqueada = erro instanceof TimeoutError;
        }
        await primeira?.liberar();
        const segunda = await deps?.criarSessao('SEFAZ_BA');
        reutilizada = segunda !== undefined && segunda !== primeira;
        await segunda?.liberar();
        return { processada: true };
      });
      repo.inserir({ id: 'exe_deps_portal', tipo: 'ficha-cadastral', payload: '{}', payloadBruto: '{}', apiKeyId });
      const final = await worker.executarProxima();
      expect(final?.status).toBe('SUCCESS');
      expect(segundaBloqueada).toBe(true);
      expect(reutilizada).toBe(true);
    } finally {
      limpar();
    }
  });

  it('fábrica devolve o slot quando a criação do navegador falha', async () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    try {
      const semaforo = new Semaforo(5, 1);
      const worker = criarWorker(banco, {
        semaforo,
        timeoutSemaforoMs: 200,
        criarSessao: async (portal: string) => {
          if (portal === 'SEFAZ_BA') {
            throw new BrowserError('Navegador falhou ao iniciar');
          }
          return sessaoFalsa({ liberadas: 0 });
        },
      });
      let falhou = false;
      let slotLivre = false;
      registrarExecutor('ficha-cadastral', async (_execucao, _sessao, deps) => {
        try {
          await deps?.criarSessao('SEFAZ_BA');
        } catch (erro) {
          falhou = erro instanceof BrowserError;
        }
        const reserva = await semaforo.adquirir('SEFAZ_BA', 200);
        slotLivre = true;
        reserva();
        return { processada: true };
      });
      repo.inserir({ id: 'exe_deps_falha', tipo: 'ficha-cadastral', payload: '{}', payloadBruto: '{}', apiKeyId });
      const final = await worker.executarProxima();
      expect(final?.status).toBe('SUCCESS');
      expect(falhou).toBe(true);
      expect(slotLivre).toBe(true);
    } finally {
      limpar();
    }
  });

  it('fábrica libera o slot do portal quando a sessão filha é encerrada', async () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    try {
      const semaforo = new Semaforo(5, 1);
      const worker = criarWorker(banco, { semaforo, timeoutSemaforoMs: 200 });
      let slotLivreAposLiberar = false;
      registrarExecutor('ficha-cadastral', async (_execucao, _sessao, deps) => {
        const filha = await deps?.criarSessao('SEFAZ_BA');
        await filha?.liberar();
        const reserva = await semaforo.adquirir('SEFAZ_BA', 200);
        slotLivreAposLiberar = true;
        reserva();
        return { processada: true };
      });
      repo.inserir({ id: 'exe_deps_slot', tipo: 'ficha-cadastral', payload: '{}', payloadBruto: '{}', apiKeyId });
      const final = await worker.executarProxima();
      expect(final?.status).toBe('SUCCESS');
      expect(slotLivreAposLiberar).toBe(true);
    } finally {
      limpar();
    }
  });
});
