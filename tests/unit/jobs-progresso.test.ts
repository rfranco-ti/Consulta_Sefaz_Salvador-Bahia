import { beforeEach, describe, expect, it } from 'vitest';
import type { EventoProgresso } from '../../src/modules/jobs/job.types.js';
import {
  CanalProgresso,
  observarProgresso,
  obterCanalProgresso,
  publicarProgresso,
} from '../../src/modules/jobs/progresso.js';

function montarEvento(
  execucaoId: string,
  status: EventoProgresso['status'],
  tentativa = 0,
): EventoProgresso {
  return { execucaoId, status, posicaoFila: null, tentativa };
}

beforeEach(() => {
  obterCanalProgresso().limpar();
});

describe('canal de progresso', () => {
  it('entrega eventos na ordem exata de publicação', () => {
    const canal = new CanalProgresso();
    const recebidos: EventoProgresso[] = [];
    canal.observar('exe_ordem', (evento) => {
      recebidos.push(evento);
    });
    canal.publicar(montarEvento('exe_ordem', 'RUNNING', 1));
    canal.publicar({ execucaoId: 'exe_ordem', status: 'RUNNING', posicaoFila: 2, tentativa: 1 });
    canal.publicar(montarEvento('exe_ordem', 'SUCCESS', 1));
    expect(recebidos.map((evento) => evento.status)).toEqual(['RUNNING', 'RUNNING', 'SUCCESS']);
    expect(recebidos[1]?.posicaoFila).toBe(2);
    expect(recebidos.map((evento) => evento.execucaoId)).toEqual([
      'exe_ordem',
      'exe_ordem',
      'exe_ordem',
    ]);
  });

  it('isola ouvintes por execução', () => {
    const canal = new CanalProgresso();
    const recebidosA: EventoProgresso[] = [];
    const recebidosB: EventoProgresso[] = [];
    canal.observar('exe_a', (evento) => {
      recebidosA.push(evento);
    });
    canal.observar('exe_b', (evento) => {
      recebidosB.push(evento);
    });
    canal.publicar(montarEvento('exe_a', 'RUNNING', 1));
    canal.publicar(montarEvento('exe_b', 'SUCCESS', 1));
    expect(recebidosA.map((evento) => evento.status)).toEqual(['RUNNING']);
    expect(recebidosB.map((evento) => evento.status)).toEqual(['SUCCESS']);
    expect(canal.contar()).toBe(2);
    expect(canal.contar('exe_a')).toBe(1);
    expect(canal.contar('exe_b')).toBe(1);
  });

  it('cancela a inscrição sem deixar ouvinte órfão', () => {
    const canal = new CanalProgresso();
    const recebidos: EventoProgresso[] = [];
    const cancelar = canal.observar('exe_saida', (evento) => {
      recebidos.push(evento);
    });
    canal.publicar(montarEvento('exe_saida', 'RUNNING', 1));
    cancelar();
    cancelar();
    canal.publicar(montarEvento('exe_saida', 'SUCCESS', 1));
    expect(recebidos.map((evento) => evento.status)).toEqual(['RUNNING']);
    expect(canal.contar('exe_saida')).toBe(0);
    expect(canal.contar()).toBe(0);
  });

  it('publicação final entrega o evento e remove os ouvintes', () => {
    const canal = new CanalProgresso();
    const recebidos: EventoProgresso[] = [];
    canal.observar('exe_fim', (evento) => {
      recebidos.push(evento);
    });
    canal.publicar(montarEvento('exe_fim', 'RUNNING', 1));
    canal.publicarFinal(montarEvento('exe_fim', 'SUCCESS', 1));
    canal.publicar(montarEvento('exe_fim', 'FAILED', 2));
    expect(recebidos.map((evento) => evento.status)).toEqual(['RUNNING', 'SUCCESS']);
    expect(canal.contar('exe_fim')).toBe(0);
  });

  it('suporta vários ouvintes na mesma execução', () => {
    const canal = new CanalProgresso();
    const primeiro: EventoProgresso[] = [];
    const segundo: EventoProgresso[] = [];
    const cancelarPrimeiro = canal.observar('exe_multi', (evento) => {
      primeiro.push(evento);
    });
    canal.observar('exe_multi', (evento) => {
      segundo.push(evento);
    });
    canal.publicar(montarEvento('exe_multi', 'RUNNING', 1));
    cancelarPrimeiro();
    canal.publicar(montarEvento('exe_multi', 'SUCCESS', 1));
    expect(primeiro.map((evento) => evento.status)).toEqual(['RUNNING']);
    expect(segundo.map((evento) => evento.status)).toEqual(['RUNNING', 'SUCCESS']);
    expect(canal.contar('exe_multi')).toBe(1);
  });

  it('ignora publicação sem ouvintes', () => {
    const canal = new CanalProgresso();
    expect(() => canal.publicar(montarEvento('exe_fantasma', 'RUNNING', 0))).not.toThrow();
    expect(canal.contar('exe_fantasma')).toBe(0);
  });

  it('funções do módulo compartilham o canal único', () => {
    const recebidos: EventoProgresso[] = [];
    const cancelar = observarProgresso('exe_modulo', (evento) => {
      recebidos.push(evento);
    });
    publicarProgresso(montarEvento('exe_modulo', 'RUNNING', 1));
    publicarProgresso(montarEvento('exe_modulo', 'SUCCESS', 1));
    cancelar();
    expect(recebidos.map((evento) => evento.status)).toEqual(['RUNNING', 'SUCCESS']);
    expect(obterCanalProgresso().contar('exe_modulo')).toBe(0);
  });
});
