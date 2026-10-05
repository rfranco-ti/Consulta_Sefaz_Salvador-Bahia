import { describe, expect, it } from 'vitest';
import { criarSemaforo, Semaforo } from '../../src/modules/jobs/semaphore.js';
import { TimeoutError } from '../../src/shared/errors/index.js';

async function continuaAguardando(promessa: Promise<() => void>): Promise<boolean> {
  let atendida = false;
  promessa.then(
    () => {
      atendida = true;
    },
    () => {
      atendida = true;
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  return !atendida;
}

describe('Semaforo', () => {
  it('atende aquisições na ordem exata de chegada com limite 1', async () => {
    const semaforo = new Semaforo(1, 1);
    const ordem: string[] = [];
    const liberaAtual = await semaforo.adquirir('sefaz-bahia', 1000);
    const segunda = semaforo.adquirir('sefaz-bahia', 1000).then((libera) => {
      ordem.push('segunda');
      return libera;
    });
    const terceira = semaforo.adquirir('sefaz-bahia', 1000).then((libera) => {
      ordem.push('terceira');
      return libera;
    });
    const quarta = semaforo.adquirir('sefaz-bahia', 1000).then((libera) => {
      ordem.push('quarta');
      return libera;
    });
    liberaAtual();
    const liberaSegunda = await segunda;
    expect(ordem).toEqual(['segunda']);
    liberaSegunda();
    const liberaTerceira = await terceira;
    expect(ordem).toEqual(['segunda', 'terceira']);
    liberaTerceira();
    const liberaQuarta = await quarta;
    expect(ordem).toEqual(['segunda', 'terceira', 'quarta']);
    liberaQuarta();
  });

  it('respeita o limite global e a terceira aquisição espera', async () => {
    const semaforo = new Semaforo(2, 2);
    const liberaPrimeira = await semaforo.adquirir('sefaz-bahia', 1000);
    const liberaSegunda = await semaforo.adquirir('sefaz-salvador', 1000);
    const terceira = semaforo.adquirir('sefaz-bahia', 1000);
    expect(await continuaAguardando(terceira)).toBe(true);
    liberaPrimeira();
    const liberaTerceira = await terceira;
    liberaSegunda();
    liberaTerceira();
  });

  it('portais diferentes rodam em paralelo e o mesmo portal serializa', async () => {
    const semaforo = new Semaforo(5, 1);
    const liberaBahia = await semaforo.adquirir('sefaz-bahia', 1000);
    const salvador = semaforo.adquirir('sefaz-salvador', 1000);
    expect(await continuaAguardando(salvador)).toBe(false);
    const liberaSalvador = await salvador;
    const segundaBahia = semaforo.adquirir('sefaz-bahia', 1000);
    expect(await continuaAguardando(segundaBahia)).toBe(true);
    liberaBahia();
    const liberaBahiaSegunda = await segundaBahia;
    liberaSalvador();
    liberaBahiaSegunda();
  });

  it('liberação acorda o próximo e mantém os demais na fila', async () => {
    const semaforo = new Semaforo(1, 1);
    const liberaAtual = await semaforo.adquirir('sefaz-bahia', 1000);
    const proximaBahia = semaforo.adquirir('sefaz-bahia', 1000);
    const proximaSalvador = semaforo.adquirir('sefaz-salvador', 1000);
    liberaAtual();
    const liberaBahia = await proximaBahia;
    expect(await continuaAguardando(proximaSalvador)).toBe(true);
    liberaBahia();
    const liberaSalvador = await proximaSalvador;
    liberaSalvador();
  });

  it('liberação pula o primeiro da fila quando ele não é elegível', async () => {
    const semaforo = new Semaforo(2, 1);
    const liberaBahia = await semaforo.adquirir('sefaz-bahia', 1000);
    const liberaSalvador = await semaforo.adquirir('sefaz-salvador', 1000);
    const esperaBahia = semaforo.adquirir('sefaz-bahia', 1000);
    const esperaSalvador = semaforo.adquirir('sefaz-salvador', 1000);
    liberaSalvador();
    const liberaSalvadorSeguinte = await esperaSalvador;
    expect(await continuaAguardando(esperaBahia)).toBe(true);
    liberaBahia();
    const liberaBahiaSeguinte = await esperaBahia;
    liberaSalvadorSeguinte();
    liberaBahiaSeguinte();
  });

  it('timeout excedido lança TimeoutError com portal e tempo', async () => {
    const semaforo = new Semaforo(1, 1);
    const libera = await semaforo.adquirir('sefaz-bahia', 1000);
    try {
      await semaforo.adquirir('sefaz-bahia', 30);
      expect.unreachable('aquisição deveria ter expirado');
    } catch (erro) {
      expect(erro).toBeInstanceOf(TimeoutError);
      if (erro instanceof TimeoutError) {
        expect(erro.message).toContain('sefaz-bahia');
        expect(erro.message).toContain('30');
      } else {
        expect.unreachable('esperava TimeoutError');
      }
    } finally {
      libera();
    }
  });

  it('liberação dupla não corrompe os contadores', async () => {
    const semaforo = new Semaforo(1, 1);
    const libera = await semaforo.adquirir('sefaz-bahia', 1000);
    const esperaPrimeira = semaforo.adquirir('sefaz-bahia', 1000);
    const esperaSegunda = semaforo.adquirir('sefaz-salvador', 1000);
    libera();
    libera();
    const liberaPrimeira = await esperaPrimeira;
    expect(await continuaAguardando(esperaSegunda)).toBe(true);
    liberaPrimeira();
    const liberaSegunda = await esperaSegunda;
    liberaSegunda();
  });

  it('espera expirada não consome vaga posterior', async () => {
    const semaforo = new Semaforo(1, 1);
    const libera = await semaforo.adquirir('sefaz-bahia', 1000);
    await expect(semaforo.adquirir('sefaz-bahia', 20)).rejects.toBeInstanceOf(
      TimeoutError,
    );
    libera();
    const proxima = semaforo.adquirir('sefaz-bahia', 1000);
    expect(await continuaAguardando(proxima)).toBe(false);
    const liberaProxima = await proxima;
    liberaProxima();
  });

  it('factory cria instância a partir do env', async () => {
    const semaforo = criarSemaforo();
    expect(semaforo).toBeInstanceOf(Semaforo);
    const libera = await semaforo.adquirir('sefaz-bahia', 1000);
    libera();
  });
});
