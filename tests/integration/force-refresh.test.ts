import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cacheConfig } from '../../src/config/cache.js';
import { CacheRepository } from '../../src/database/repositories/cache.repository.js';
import {
  CacheConsultas,
  montarChaveCache,
} from '../../src/modules/automation/automation.cache.js';
import { AutomationService } from '../../src/modules/automation/automation.service.js';
import type { IniciarExecucaoInput } from '../../src/modules/automation/automation.types.js';
import { ExecucoesRepository } from '../../src/database/index.js';
import { CanalProgresso } from '../../src/modules/jobs/progresso.js';
import { criarBancoTemporario, criarChaveApi } from './database-helpers.js';

const TIPO = 'sefaz-bahia' as const;
const CNPJ = '12345678000190';
const PARAMS = { cnpj: CNPJ };

interface Mundo {
  banco: Database.Database;
  servico: AutomationService;
  cache: CacheConsultas;
  repo: CacheRepository;
  chaveA: string;
  chaveB: string;
  limpar: () => void;
  avancar: (ms: number) => void;
}

function montarMundo(): Mundo {
  const tmp = criarBancoTemporario();
  const chaveA = criarChaveApi(tmp.banco).id;
  const chaveB = criarChaveApi(tmp.banco).id;
  const armazenamento = mkdtempSync(join(tmpdir(), 'force-refresh-'));
  let agoraMs = Date.now();
  const agora = (): number => agoraMs;
  const cache = new CacheConsultas({ banco: tmp.banco, agora });
  const servico = new AutomationService({
    banco: tmp.banco,
    cache,
    canal: new CanalProgresso(),
    diretorioArmazenamento: armazenamento,
    agora,
  });
  return {
    banco: tmp.banco,
    servico,
    cache,
    repo: new CacheRepository(tmp.banco),
    chaveA,
    chaveB,
    limpar: tmp.limpar,
    avancar: (ms: number) => {
      agoraMs += ms;
    },
  };
}

function entrada(apiKeyId: string, parcial: Partial<IniciarExecucaoInput> = {}): IniciarExecucaoInput {
  return {
    tipo: TIPO,
    params: { ...PARAMS },
    artefatos: 'nenhum',
    inline: false,
    forceRefresh: false,
    apiKeyId,
    ...parcial,
  };
}

function reservarComoRunning(banco: Database.Database): void {
  new ExecucoesRepository(banco).reservarProximaPendente();
}

function chave(): string {
  return montarChaveCache(TIPO, PARAMS);
}

/** Enfileira e conclui com sucesso; devolve o id da execução. */
async function concluirSucesso(
  mundo: Mundo,
  apiKeyId: string,
  dados: Record<string, unknown>,
  forcar = false,
): Promise<string> {
  const criada = await mundo.servico.iniciar(entrada(apiKeyId, { forceRefresh: forcar }));
  reservarComoRunning(mundo.banco);
  await mundo.servico.finalizar(criada.execucaoId, { sucesso: true, dados });
  return criada.execucaoId;
}

function finalizadoEm(banco: Database.Database, execucaoId: string): string {
  const linha = banco
    .prepare<[string], { finalizado_em: string }>('SELECT finalizado_em FROM execucoes WHERE id = ?')
    .get(execucaoId);
  if (linha === undefined) {
    throw new Error(`Execução ${execucaoId} não encontrada`);
  }
  return linha.finalizado_em;
}

beforeEach(() => {
  new CanalProgresso().limpar();
});

afterEach(() => {
  new CanalProgresso().limpar();
});

describe('forceRefresh sem perda de disponibilidade', () => {
  it('sucesso forçado SUBSTITUI o valor com TTL fresco', async () => {
    const mundo = montarMundo();
    try {
      await concluirSucesso(mundo, mundo.chaveA, { situacao: 'ativa-1' });
      const antes = mundo.repo.obter(chave());
      expect(antes).not.toBeNull();
      expect(JSON.parse(antes?.dados ?? '{}')).toMatchObject({
        sucesso: true,
        dados: { situacao: 'ativa-1' },
      });

      mundo.avancar(60_000);
      await concluirSucesso(mundo, mundo.chaveB, { situacao: 'ativa-2' }, true);

      const depois = mundo.repo.obter(chave());
      expect(depois).not.toBeNull();
      expect(JSON.parse(depois?.dados ?? '{}')).toMatchObject({
        sucesso: true,
        dados: { situacao: 'ativa-2' },
      });
      // TTL fresco: expiração posterior à anterior.
      expect(Date.parse(depois?.expiraEm ?? '')).toBeGreaterThan(Date.parse(antes?.expiraEm ?? ''));

      const leitura = new CacheConsultas({ banco: mundo.banco }).ler(TIPO, PARAMS);
      expect(leitura?.dados).toMatchObject({ sucesso: true, dados: { situacao: 'ativa-2' } });
    } finally {
      mundo.limpar();
    }
  });

  it('falha forçada PRESERVA a entrada: normal seguinte ainda acerta com a expiração original', async () => {
    const mundo = montarMundo();
    try {
      await concluirSucesso(mundo, mundo.chaveA, { situacao: 'ativa-1' });
      const expiracaoOriginal = mundo.repo.obter(chave())?.expiraEm;
      expect(expiracaoOriginal).toBeDefined();

      // Inicia o refresh forçado: a entrada anterior continua legível
      // enquanto o novo voo está em andamento (sem invalidação antecipada).
      const forcada = await mundo.servico.iniciar(entrada(mundo.chaveB, { forceRefresh: true }));
      expect(forcada.status).toBe('PENDING');
      expect(forcada.cache).toMatchObject({ hit: false });
      expect(mundo.cache.ler(TIPO, PARAMS)?.dados).toMatchObject({
        sucesso: true,
        dados: { situacao: 'ativa-1' },
      });

      reservarComoRunning(mundo.banco);
      const falha = await mundo.servico.falhar(forcada.execucaoId, new Error('Portal fora do ar'));
      expect(falha.status).toBe('FAILED');

      // A entrada sqlite segue intacta, com a expiração ORIGINAL.
      const preservada = mundo.repo.obter(chave());
      expect(preservada).not.toBeNull();
      expect(JSON.parse(preservada?.dados ?? '{}')).toMatchObject({
        sucesso: true,
        dados: { situacao: 'ativa-1' },
      });
      expect(preservada?.expiraEm).toBe(expiracaoOriginal);

      // Outro cliente, sem pedir refresh, continua sendo servido do cache.
      const normal = await mundo.servico.iniciar(entrada(mundo.chaveA));
      expect(normal.status).toBe('SUCCESS');
      expect(normal.cache).toMatchObject({ hit: true });
      expect(normal.resultado?.dados).toEqual({ situacao: 'ativa-1' });
    } finally {
      mundo.limpar();
    }
  });

  it('requisição normal após refresh forçado acerta o valor atualizado', async () => {
    const mundo = montarMundo();
    try {
      await concluirSucesso(mundo, mundo.chaveA, { situacao: 'ativa-1' });
      await concluirSucesso(mundo, mundo.chaveB, { situacao: 'ativa-2' }, true);

      const normal = await mundo.servico.iniciar(entrada(mundo.chaveA));
      expect(normal.status).toBe('SUCCESS');
      expect(normal.cache).toMatchObject({ hit: true });
      expect(normal.resultado?.dados).toEqual({ situacao: 'ativa-2' });
    } finally {
      mundo.limpar();
    }
  });

  it('age gate continua impedindo ressurreição com TTL fresco após refresh forçado', async () => {
    const mundo = montarMundo();
    try {
      const ttlMs = cacheConfig(TIPO).ttlMs;
      const primeira = await concluirSucesso(mundo, mundo.chaveA, { situacao: 'ativa-1' });
      mundo.avancar(60_000);
      const forcadaId = await concluirSucesso(mundo, mundo.chaveB, { situacao: 'ativa-2' }, true);
      expect(mundo.repo.obter(chave())).not.toBeNull();

      // Controle positivo: evict explícito + sondagem ainda dentro do TTL
      // regrava com a expiração ORIGINAL (finalizadoEm + TTL), nunca fresca.
      mundo.cache.invalidar(TIPO, PARAMS);
      expect(mundo.repo.obter(chave())).toBeNull();
      await mundo.servico.consultar(forcadaId, mundo.chaveB);
      const restaurada = mundo.repo.obter(chave());
      expect(restaurada).not.toBeNull();
      expect(restaurada?.expiraEm).toBe(
        new Date(Date.parse(finalizadoEm(mundo.banco, forcadaId)) + ttlMs).toISOString(),
      );

      // Após o TTL de AMBAS as execuções, sondar não ressuscita nada.
      mundo.cache.invalidar(TIPO, PARAMS);
      mundo.avancar(ttlMs + 60_000);
      await mundo.servico.consultar(primeira, mundo.chaveA);
      await mundo.servico.consultar(forcadaId, mundo.chaveB);
      expect(new CacheConsultas({ banco: mundo.banco }).ler(TIPO, PARAMS)).toBeNull();
      expect(mundo.repo.obter(chave())).toBeNull();
    } finally {
      mundo.limpar();
    }
  });

  it('forceRefresh não altera a chave: pedido forçado entra no voo em andamento dos mesmos parâmetros', async () => {
    const mundo = montarMundo();
    try {
      // Chave pura: forceRefresh é controle, não entra no cálculo.
      expect(montarChaveCache(TIPO, PARAMS)).toBe(montarChaveCache(TIPO, { cnpj: CNPJ }));
      expect(montarChaveCache(TIPO, PARAMS)).not.toBe(
        montarChaveCache(TIPO, { cnpj: '98765432000198' }),
      );

      // O pedido forçado compartilha o voo PENDING dos mesmos parâmetros
      // (mesma normalização, sem duplicar a ida ao portal).
      const pendente = await mundo.servico.iniciar(entrada(mundo.chaveA));
      expect(pendente.status).toBe('PENDING');
      const forcada = await mundo.servico.iniciar(entrada(mundo.chaveB, { forceRefresh: true }));
      expect(forcada.execucaoId).toBe(pendente.execucaoId);
      expect(forcada.cache).toMatchObject({ hit: false });
    } finally {
      mundo.limpar();
    }
  });
});
