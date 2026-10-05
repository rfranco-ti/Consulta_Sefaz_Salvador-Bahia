import type Database from 'better-sqlite3';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TipoAutomacao } from '../../src/automations/registry.js';
import type { Execucao } from '../../src/database/index.js';
import { ExecucoesRepository } from '../../src/database/index.js';
import type { BrowserSession } from '../../src/modules/browser/browser.types.js';
import { limparExecutores, registrarExecutor } from '../../src/modules/jobs/executor.js';
import {
  iniciarWorker,
  obterWorker,
  pararWorker,
  WorkerFila,
} from '../../src/modules/jobs/job.worker.js';
import type { EventoProgresso } from '../../src/modules/jobs/job.types.js';
import { obterCanalProgresso } from '../../src/modules/jobs/progresso.js';
import { Semaforo } from '../../src/modules/jobs/semaphore.js';
import {
  BrowserError,
  ConflictError,
  TimeoutError,
  ValidationError,
} from '../../src/shared/errors/index.js';
import { criarBancoTemporario, criarChaveApi } from './database-helpers.js';

function sessaoFalsa(): BrowserSession {
  return {
    browser: {},
    context: {},
    page: {},
    liberar: async () => undefined,
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

function enfileirar(
  repo: ExecucoesRepository,
  apiKeyId: string,
  id: string,
  tipo: TipoAutomacao = 'sefaz-bahia',
): Execucao {
  return repo.inserir({ id, tipo, payload: '{}', payloadBruto: '{}', apiKeyId });
}

function criarWorker(
  banco: Database.Database,
  parcial: {
    semaforo?: Semaforo;
    timeoutSemaforoMs?: number;
    criarSessao?: (portal: string) => Promise<BrowserSession>;
    intervaloSondagemMs?: number;
    backoffs?: number[];
    sessoes?: { total: number };
  } = {},
): WorkerFila {
  return new WorkerFila({
    banco,
    semaforo: parcial.semaforo,
    timeoutSemaforoMs: parcial.timeoutSemaforoMs,
    criarSessao:
      parcial.criarSessao ??
      (async () => {
        if (parcial.sessoes !== undefined) {
          parcial.sessoes.total += 1;
        }
        return sessaoFalsa();
      }),
    esperar: async () => undefined,
    backoffMs: (tentativa) => {
      parcial.backoffs?.push(tentativa);
      return 0;
    },
    intervaloSondagemMs: parcial.intervaloSondagemMs,
    intervaloVarreduraMs: 0,
    logger: pino({ level: 'silent' }),
  });
}

function exigirReserva(valor: Execucao | null, esperado: string): Execucao {
  expect(valor?.id).toBe(esperado);
  if (valor === null) {
    throw new Error(`reserva esperada não aconteceu para ${esperado}`);
  }
  return valor;
}

async function escoar(): Promise<void> {
  await new Promise<void>((resolver) => {
    setTimeout(resolver, 0);
  });
}

async function aguardarCondicao(condicao: () => boolean, limiteMs = 5000): Promise<void> {
  const inicio = Date.now();
  while (!condicao()) {
    if (Date.now() - inicio > limiteMs) {
      throw new Error('condição não atendida a tempo');
    }
    await new Promise<void>((resolver) => {
      setTimeout(resolver, 10);
    });
  }
}

beforeEach(() => {
  limparExecutores();
  obterCanalProgresso().limpar();
});

afterEach(() => {
  limparExecutores();
  obterCanalProgresso().limpar();
});

describe('worker de execuções', () => {
  it('tenta de novo após falha recuperável e conclui na terceira tentativa', async () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    try {
      const backoffs: number[] = [];
      const sessoes = { total: 0 };
      const worker = criarWorker(banco, { backoffs, sessoes });
      let chamadas = 0;
      registrarExecutor('sefaz-bahia', async () => {
        chamadas += 1;
        if (chamadas <= 2) {
          throw new TimeoutError('Portal demorou a responder');
        }
        return { situacao: 'ativa' };
      });
      enfileirar(repo, apiKeyId, 'exe_retry_ok');
      const eventos: EventoProgresso[] = [];
      obterCanalProgresso().observar('exe_retry_ok', (evento) => {
        eventos.push(evento);
      });
      const final = await worker.executarProxima();
      expect(final?.status).toBe('SUCCESS');
      expect(chamadas).toBe(3);
      expect(repo.buscarPorId('exe_retry_ok')?.attempts).toBe(3);
      expect(backoffs).toEqual([1, 2]);
      expect(sessoes.total).toBe(3);
      expect(JSON.parse(final?.resultado ?? '')).toEqual({ situacao: 'ativa' });
      expect(eventos.map((evento) => evento.status)).toEqual([
        'RUNNING',
        'RUNNING',
        'RUNNING',
        'RUNNING',
        'SUCCESS',
      ]);
      expect(eventos.map((evento) => evento.tentativa)).toEqual([0, 1, 2, 3, 3]);
      expect(obterCanalProgresso().contar('exe_retry_ok')).toBe(0);
    } finally {
      limpar();
    }
  });

  it('falha quando as tentativas recuperáveis se esgotam', async () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    try {
      const backoffs: number[] = [];
      const worker = criarWorker(banco, { backoffs });
      let chamadas = 0;
      registrarExecutor('sefaz-bahia', async () => {
        chamadas += 1;
        throw new TimeoutError('Portal demorou a responder');
      });
      enfileirar(repo, apiKeyId, 'exe_retry_out');
      const final = await worker.executarProxima();
      expect(final?.status).toBe('FAILED');
      expect(chamadas).toBe(3);
      expect(repo.buscarPorId('exe_retry_out')?.attempts).toBe(3);
      expect(backoffs).toEqual([1, 2]);
      expect(JSON.parse(final?.erro ?? '')).toMatchObject({ code: 'TIMEOUT' });
      expect(final?.resultado).toBeNull();
    } finally {
      limpar();
    }
  });

  it('não tenta de novo após erro de validação', async () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    try {
      const backoffs: number[] = [];
      const worker = criarWorker(banco, { backoffs });
      let chamadas = 0;
      registrarExecutor('sefaz-bahia', async () => {
        chamadas += 1;
        throw new ValidationError('CNPJ inválido para a consulta');
      });
      enfileirar(repo, apiKeyId, 'exe_sem_retry');
      const final = await worker.executarProxima();
      expect(final?.status).toBe('FAILED');
      expect(chamadas).toBe(1);
      expect(repo.buscarPorId('exe_sem_retry')?.attempts).toBe(1);
      expect(backoffs).toEqual([]);
      expect(JSON.parse(final?.erro ?? '')).toMatchObject({ code: 'VALIDATION_ERROR' });
    } finally {
      limpar();
    }
  });

  it('tenta de novo após erro transitório do navegador', async () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    try {
      const worker = criarWorker(banco, {});
      let chamadas = 0;
      registrarExecutor('sefaz-bahia', async () => {
        chamadas += 1;
        if (chamadas === 1) {
          throw new BrowserError('Navegador falhou ao iniciar');
        }
        return { situacao: 'ativa' };
      });
      enfileirar(repo, apiKeyId, 'exe_browser_retry');
      const final = await worker.executarProxima();
      expect(final?.status).toBe('SUCCESS');
      expect(chamadas).toBe(2);
      expect(repo.buscarPorId('exe_browser_retry')?.attempts).toBe(2);
    } finally {
      limpar();
    }
  });

  it('tenta de novo quando a sessão falha ao ser criada', async () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    try {
      let sessoesTentadas = 0;
      let chamadas = 0;
      const worker = criarWorker(banco, {
        criarSessao: async () => {
          sessoesTentadas += 1;
          if (sessoesTentadas === 1) {
            throw new BrowserError('Navegador falhou ao iniciar');
          }
          return sessaoFalsa();
        },
      });
      registrarExecutor('sefaz-bahia', async () => {
        chamadas += 1;
        return { situacao: 'ativa' };
      });
      enfileirar(repo, apiKeyId, 'exe_sessao_retry');
      const final = await worker.executarProxima();
      expect(final?.status).toBe('SUCCESS');
      expect(sessoesTentadas).toBe(2);
      expect(chamadas).toBe(1);
      expect(repo.buscarPorId('exe_sessao_retry')?.attempts).toBe(2);
    } finally {
      limpar();
    }
  });

  it('falha sem retry quando nenhum executor foi registrado', async () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    try {
      const backoffs: number[] = [];
      const worker = criarWorker(banco, { backoffs });
      enfileirar(repo, apiKeyId, 'exe_sem_executor', 'cadin-salvador');
      const final = await worker.executarProxima();
      expect(final?.status).toBe('FAILED');
      expect(backoffs).toEqual([]);
      expect(repo.buscarPorId('exe_sem_executor')?.attempts).toBe(1);
      expect(JSON.parse(final?.erro ?? '')).toMatchObject({ code: 'INTERNAL_ERROR' });
      expect(JSON.parse(final?.erro ?? '').message).toContain('executor');
    } finally {
      limpar();
    }
  });

  it('falha quando o semáforo fica saturado', async () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    const semaforo = new Semaforo(1, 1);
    const libera = await semaforo.adquirir('SEFAZ_BA', 1000);
    try {
      const worker = criarWorker(banco, { semaforo, timeoutSemaforoMs: 20 });
      let chamadas = 0;
      registrarExecutor('sefaz-bahia', async () => {
        chamadas += 1;
        return { processada: true };
      });
      enfileirar(repo, apiKeyId, 'exe_semaforo');
      const final = await worker.executarProxima();
      expect(final?.status).toBe('FAILED');
      expect(chamadas).toBe(0);
      expect(JSON.parse(final?.erro ?? '')).toMatchObject({ code: 'TIMEOUT' });
    } finally {
      libera();
      limpar();
    }
  });

  it('cancelada durante a execução não grava sucesso', async () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    try {
      const worker = criarWorker(banco, {});
      let liberar!: () => void;
      const porta = new Promise<void>((resolver) => {
        liberar = resolver;
      });
      registrarExecutor('sefaz-bahia', async () => {
        await porta;
        return { situacao: 'ativa' };
      });
      enfileirar(repo, apiKeyId, 'exe_corrida');
      const reserva = exigirReserva(repo.reservarProximaPendente(), 'exe_corrida');
      const tarefa = worker.processar(reserva);
      await escoar();
      expect(() => worker.cancelar('exe_corrida')).toThrow(ConflictError);
      liberar();
      const final = await tarefa;
      expect(final.status).toBe('FAILED');
      expect(JSON.parse(final.erro ?? '')).toMatchObject({ code: 'CANCELLED' });
      expect(final.resultado).toBeNull();
      expect(obterCanalProgresso().contar('exe_corrida')).toBe(0);
    } finally {
      limpar();
    }
  });

  it('concluída antes do cancelamento mantém o sucesso', async () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    try {
      const worker = criarWorker(banco, {});
      registrarExecutor('sefaz-bahia', async () => ({ situacao: 'ativa' }));
      enfileirar(repo, apiKeyId, 'exe_venceu');
      const final = await worker.executarProxima();
      expect(final?.status).toBe('SUCCESS');
      expect(() => worker.cancelar('exe_venceu')).toThrow(ConflictError);
      expect(repo.buscarPorId('exe_venceu')?.status).toBe('SUCCESS');
    } finally {
      limpar();
    }
  });

  it('consome pendentes em loop até esvaziar', async () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    const worker = new WorkerFila({
      banco,
      criarSessao: async () => sessaoFalsa(),
      intervaloSondagemMs: 5,
      intervaloVarreduraMs: 0,
      logger: pino({ level: 'silent' }),
    });
    try {
      registrarExecutor('sefaz-bahia', async () => ({ processada: true }));
      enfileirar(repo, apiKeyId, 'exe_loop_1');
      enfileirar(repo, apiKeyId, 'exe_loop_2');
      await worker.iniciar();
      await aguardarCondicao(
        () =>
          repo.buscarPorId('exe_loop_1')?.status === 'SUCCESS' &&
          repo.buscarPorId('exe_loop_2')?.status === 'SUCCESS',
      );
      await worker.parar();
      expect(repo.buscarPorId('exe_loop_1')?.status).toBe('SUCCESS');
      expect(repo.buscarPorId('exe_loop_2')?.status).toBe('SUCCESS');
    } finally {
      await worker.parar();
      limpar();
    }
  });

  it('para com graça sem matar a execução em andamento', async () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    const worker = new WorkerFila({
      banco,
      criarSessao: async () => sessaoFalsa(),
      intervaloSondagemMs: 5,
      intervaloVarreduraMs: 0,
      logger: pino({ level: 'silent' }),
    });
    try {
      let liberar!: () => void;
      const porta = new Promise<void>((resolver) => {
        liberar = resolver;
      });
      registrarExecutor('sefaz-bahia', async () => {
        await porta;
        return { processada: true };
      });
      enfileirar(repo, apiKeyId, 'exe_graciosa');
      await worker.iniciar();
      await aguardarCondicao(() => repo.buscarPorId('exe_graciosa')?.status === 'RUNNING');
      const parada = worker.parar();
      await escoar();
      expect(repo.buscarPorId('exe_graciosa')?.status).toBe('RUNNING');
      liberar();
      await parada;
      expect(repo.buscarPorId('exe_graciosa')?.status).toBe('SUCCESS');
    } finally {
      await worker.parar();
      limpar();
    }
  });

  it('singleton inicia uma vez e para de forma idempotente', async () => {
    const { banco, limpar } = montarBanco();
    try {
      const opcoes = {
        banco,
        criarSessao: async () => sessaoFalsa(),
        intervaloSondagemMs: 5,
        intervaloVarreduraMs: 0,
        logger: pino({ level: 'silent' }),
      };
      const worker = await iniciarWorker(opcoes);
      expect(obterWorker()).toBe(worker);
      await expect(iniciarWorker(opcoes)).rejects.toThrow(ConflictError);
      await pararWorker();
      expect(obterWorker()).toBeNull();
      await pararWorker();
    } finally {
      await pararWorker();
      limpar();
    }
  });
});
