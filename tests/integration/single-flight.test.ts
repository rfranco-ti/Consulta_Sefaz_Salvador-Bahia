import { describe, expect, it } from 'vitest';
import { CacheRepository } from '../../src/database/repositories/cache.repository.js';
import {
  CacheConsultas,
  montarChaveCache,
} from '../../src/modules/automation/automation.cache.js';
import { criarBancoTemporario } from './database-helpers.js';

const TIPO = 'sefaz-bahia' as const;

type Resultado = Record<string, unknown>;

function montar(): { cache: CacheConsultas; repo: CacheRepository; limpar: () => void } {
  const { banco, limpar } = criarBancoTemporario();
  return { cache: new CacheConsultas({ banco }), repo: new CacheRepository(banco), limpar };
}

describe('single-flight de consultas', () => {
  it('10 chamadas idênticas concorrentes executam 1x e recebem o mesmo resultado', async () => {
    const { cache, limpar } = montar();
    try {
      let chamadas = 0;
      let liberar: (valor: Resultado) => void = () => {};
      const executar = (): Promise<Resultado> => {
        chamadas += 1;
        return new Promise<Resultado>((resolver) => {
          liberar = resolver;
        });
      };
      const payload = { cnpj: '123' };
      const promessas = Array.from({ length: 10 }, () =>
        cache.consultarComCache({ tipo: TIPO, payload, executar }),
      );
      expect(chamadas).toBe(1);
      liberar({ situacao: 'ativa' });
      const saidas = await Promise.all(promessas);
      expect(chamadas).toBe(1);
      const referencia = saidas[0]?.resultado;
      for (const saida of saidas) {
        expect(saida.resultado).toEqual({ situacao: 'ativa' });
        expect(saida.resultado).toBe(referencia);
        expect(saida.cache.hit).toBe(false);
      }
    } finally {
      limpar();
    }
  });

  it('payloads diferentes geram execuções independentes', async () => {
    const { cache, limpar } = montar();
    try {
      let chamadasA = 0;
      let chamadasB = 0;
      const [saidaA, saidaB] = await Promise.all([
        cache.consultarComCache({
          tipo: TIPO,
          payload: { id: 'A' },
          executar: async (): Promise<Resultado> => {
            chamadasA += 1;
            return { id: 'A' };
          },
        }),
        cache.consultarComCache({
          tipo: TIPO,
          payload: { id: 'B' },
          executar: async (): Promise<Resultado> => {
            chamadasB += 1;
            return { id: 'B' };
          },
        }),
      ]);
      expect(chamadasA).toBe(1);
      expect(chamadasB).toBe(1);
      expect(saidaA?.resultado).toEqual({ id: 'A' });
      expect(saidaB?.resultado).toEqual({ id: 'B' });
    } finally {
      limpar();
    }
  });

  it('falha compartilhada libera o voo e a próxima chamada executa de novo', async () => {
    const { cache, repo, limpar } = montar();
    try {
      const payload = { cnpj: '123' };
      let tentativas = 0;
      let rejeitar: (motivo?: unknown) => void = () => {};
      const falhar = (): Promise<Resultado> => {
        tentativas += 1;
        return new Promise<Resultado>((_, rejeitarExecucao) => {
          rejeitar = rejeitarExecucao;
        });
      };
      const primeira = cache.consultarComCache({ tipo: TIPO, payload, executar: falhar });
      const segunda = cache.consultarComCache({ tipo: TIPO, payload, executar: falhar });
      expect(tentativas).toBe(1);
      rejeitar(new Error('Portal fora do ar'));
      await expect(primeira).rejects.toThrow('Portal fora do ar');
      await expect(segunda).rejects.toThrow('Portal fora do ar');
      expect(repo.obter(montarChaveCache(TIPO, payload))).toBeNull();
      const saida = await cache.consultarComCache({
        tipo: TIPO,
        payload,
        executar: async (): Promise<Resultado> => {
          tentativas += 1;
          return { situacao: 'ativa' };
        },
      });
      expect(saida.resultado).toEqual({ situacao: 'ativa' });
      expect(saida.cache.hit).toBe(false);
      expect(tentativas).toBe(2);
    } finally {
      limpar();
    }
  });

  it('forceRefresh compartilha o voo da mesma chave com chamada normal', async () => {
    const { cache, limpar } = montar();
    try {
      let chamadas = 0;
      let liberar: (valor: Resultado) => void = () => {};
      const executar = (): Promise<Resultado> => {
        chamadas += 1;
        return new Promise<Resultado>((resolver) => {
          liberar = resolver;
        });
      };
      const payload = { cnpj: '123' };
      const normal = cache.consultarComCache({ tipo: TIPO, payload, executar });
      const forcada = cache.consultarComCache({ tipo: TIPO, payload, forceRefresh: true, executar });
      expect(chamadas).toBe(1);
      liberar({ situacao: 'ativa' });
      const [saidaNormal, saidaForcada] = await Promise.all([normal, forcada]);
      expect(chamadas).toBe(1);
      expect(saidaNormal?.resultado).toEqual({ situacao: 'ativa' });
      expect(saidaForcada?.resultado).toBe(saidaNormal?.resultado);
    } finally {
      limpar();
    }
  });
});
