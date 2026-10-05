import type Database from 'better-sqlite3';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TipoAutomacao } from '../../src/automations/registry.js';
import type { Execucao } from '../../src/database/index.js';
import { ExecucoesRepository } from '../../src/database/index.js';
import type { BrowserSession } from '../../src/modules/browser/browser.types.js';
import { limparExecutores, registrarExecutor } from '../../src/modules/jobs/executor.js';
import { WorkerFila } from '../../src/modules/jobs/job.worker.js';
import type { EventoProgresso } from '../../src/modules/jobs/job.types.js';
import { obterCanalProgresso } from '../../src/modules/jobs/progresso.js';
import { Semaforo } from '../../src/modules/jobs/semaphore.js';
import { ConflictError } from '../../src/shared/errors/index.js';
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
  parcial: { semaforo?: Semaforo; filaTimeoutSeg?: number } = {},
): WorkerFila {
  return new WorkerFila({
    banco,
    semaforo: parcial.semaforo,
    criarSessao: async () => sessaoFalsa(),
    esperar: async () => undefined,
    filaTimeoutSeg: parcial.filaTimeoutSeg,
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

beforeEach(() => {
  limparExecutores();
  obterCanalProgresso().limpar();
});

afterEach(() => {
  limparExecutores();
  obterCanalProgresso().limpar();
});

describe('fila de execuções', () => {
  it('conclui três execuções na ordem exata dos tickets', async () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    try {
      const worker = criarWorker(banco);
      const ordem: string[] = [];
      registrarExecutor('sefaz-bahia', async (execucao) => {
        ordem.push(execucao.id);
        return { processada: execucao.id };
      });
      enfileirar(repo, apiKeyId, 'exe_fifo_1');
      enfileirar(repo, apiKeyId, 'exe_fifo_2');
      enfileirar(repo, apiKeyId, 'exe_fifo_3');
      const primeira = await worker.executarProxima();
      const segunda = await worker.executarProxima();
      const terceira = await worker.executarProxima();
      expect(ordem).toEqual(['exe_fifo_1', 'exe_fifo_2', 'exe_fifo_3']);
      expect(primeira?.id).toBe('exe_fifo_1');
      expect(segunda?.id).toBe('exe_fifo_2');
      expect(terceira?.id).toBe('exe_fifo_3');
      expect(primeira?.status).toBe('SUCCESS');
      expect(segunda?.status).toBe('SUCCESS');
      expect(terceira?.status).toBe('SUCCESS');
      expect(await worker.executarProxima()).toBeNull();
    } finally {
      limpar();
    }
  });

  it('serializa execuções do mesmo portal', async () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    try {
      const worker = criarWorker(banco, { semaforo: new Semaforo(5, 1) });
      const ordem: string[] = [];
      let liberarA!: () => void;
      const portaA = new Promise<void>((resolver) => {
        liberarA = resolver;
      });
      registrarExecutor('sefaz-bahia', async () => {
        ordem.push('inicio-a');
        await portaA;
        ordem.push('fim-a');
        return { lado: 'a' };
      });
      registrarExecutor('sefaz-bahia-inscricao', async () => {
        ordem.push('inicio-b');
        ordem.push('fim-b');
        return { lado: 'b' };
      });
      enfileirar(repo, apiKeyId, 'exe_par_a', 'sefaz-bahia');
      enfileirar(repo, apiKeyId, 'exe_par_b', 'sefaz-bahia-inscricao');
      const reservaA = exigirReserva(repo.reservarProximaPendente(), 'exe_par_a');
      const reservaB = exigirReserva(repo.reservarProximaPendente(), 'exe_par_b');
      const tarefaA = worker.processar(reservaA);
      const tarefaB = worker.processar(reservaB);
      await escoar();
      expect(ordem).toEqual(['inicio-a']);
      liberarA();
      const [finalA, finalB] = await Promise.all([tarefaA, tarefaB]);
      expect(ordem).toEqual(['inicio-a', 'fim-a', 'inicio-b', 'fim-b']);
      expect(finalA.status).toBe('SUCCESS');
      expect(finalB.status).toBe('SUCCESS');
    } finally {
      limpar();
    }
  });

  it('sobrepõe execuções de portais diferentes', async () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    try {
      const worker = criarWorker(banco, { semaforo: new Semaforo(5, 1) });
      const ordem: string[] = [];
      let liberarA!: () => void;
      let liberarC!: () => void;
      const portaA = new Promise<void>((resolver) => {
        liberarA = resolver;
      });
      const portaC = new Promise<void>((resolver) => {
        liberarC = resolver;
      });
      registrarExecutor('sefaz-bahia', async () => {
        ordem.push('inicio-a');
        await portaA;
        ordem.push('fim-a');
        return { lado: 'a' };
      });
      registrarExecutor('iptu-salvador', async () => {
        ordem.push('inicio-c');
        await portaC;
        ordem.push('fim-c');
        return { lado: 'c' };
      });
      enfileirar(repo, apiKeyId, 'exe_dif_a', 'sefaz-bahia');
      enfileirar(repo, apiKeyId, 'exe_dif_c', 'iptu-salvador');
      const reservaA = exigirReserva(repo.reservarProximaPendente(), 'exe_dif_a');
      const reservaC = exigirReserva(repo.reservarProximaPendente(), 'exe_dif_c');
      const tarefaA = worker.processar(reservaA);
      const tarefaC = worker.processar(reservaC);
      await escoar();
      expect(ordem).toEqual(['inicio-a', 'inicio-c']);
      liberarA();
      liberarC();
      const [finalA, finalC] = await Promise.all([tarefaA, tarefaC]);
      expect(ordem).toEqual(['inicio-a', 'inicio-c', 'fim-a', 'fim-c']);
      expect(finalA.status).toBe('SUCCESS');
      expect(finalC.status).toBe('SUCCESS');
    } finally {
      limpar();
    }
  });

  it('falha pendente além do tempo limite da fila', () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    try {
      const worker = criarWorker(banco, { filaTimeoutSeg: 90 });
      enfileirar(repo, apiKeyId, 'exe_antiga');
      enfileirar(repo, apiKeyId, 'exe_recente');
      banco
        .prepare<[string, string]>('UPDATE execucoes SET criado_em = ? WHERE id = ?')
        .run(new Date(Date.now() - 200000).toISOString(), 'exe_antiga');
      const eventos: EventoProgresso[] = [];
      obterCanalProgresso().observar('exe_antiga', (evento) => {
        eventos.push(evento);
      });
      expect(worker.expirarFila()).toBe(1);
      const expirada = repo.buscarPorId('exe_antiga');
      expect(expirada?.status).toBe('FAILED');
      expect(JSON.parse(expirada?.erro ?? '')).toMatchObject({ code: 'TIMEOUT' });
      expect(JSON.parse(expirada?.erro ?? '').message).toContain('fila');
      expect(repo.buscarPorId('exe_recente')?.status).toBe('PENDING');
      expect(worker.expirarFila()).toBe(0);
      expect(eventos.map((evento) => evento.status)).toEqual(['FAILED']);
      expect(obterCanalProgresso().contar('exe_antiga')).toBe(0);
    } finally {
      limpar();
    }
  });

  it('marca como falha a execução interrompida após reinício', () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    try {
      const worker = criarWorker(banco);
      enfileirar(repo, apiKeyId, 'exe_interrompida');
      exigirReserva(repo.reservarProximaPendente(), 'exe_interrompida');
      expect(worker.recuperar()).toBe(1);
      const final = repo.buscarPorId('exe_interrompida');
      expect(final?.status).toBe('FAILED');
      expect(JSON.parse(final?.erro ?? '')).toMatchObject({ code: 'REINICIO' });
      expect(worker.recuperar()).toBe(0);
    } finally {
      limpar();
    }
  });

  it('não executa pendente cancelada', async () => {
    const { banco, repo, apiKeyId, limpar } = montarBanco();
    try {
      const worker = criarWorker(banco);
      let chamadas = 0;
      registrarExecutor('sefaz-bahia', async () => {
        chamadas += 1;
        return { processada: true };
      });
      enfileirar(repo, apiKeyId, 'exe_cancelada');
      const eventos: EventoProgresso[] = [];
      obterCanalProgresso().observar('exe_cancelada', (evento) => {
        eventos.push(evento);
      });
      const final = worker.cancelar('exe_cancelada');
      expect(final.status).toBe('CANCELLED');
      expect(await worker.executarProxima()).toBeNull();
      expect(chamadas).toBe(0);
      expect(eventos.map((evento) => evento.status)).toEqual(['CANCELLED']);
      expect(obterCanalProgresso().contar('exe_cancelada')).toBe(0);
      expect(() => worker.cancelar('exe_cancelada')).toThrow(ConflictError);
    } finally {
      limpar();
    }
  });
});
