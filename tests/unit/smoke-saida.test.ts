import { afterEach, describe, expect, it, vi } from 'vitest';
import { drenarStdout } from '../../scripts/smoke-nucleo.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('drenarStdout', () => {
  it('escreve o relatório com quebra de linha e resolve após a descarga', async () => {
    const escritos: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(
      (bloco: string | Uint8Array, ...resto: Array<unknown>): boolean => {
        escritos.push(String(bloco));
        const retorno: unknown = resto.find((valor) => typeof valor === 'function');
        (retorno as unknown as () => void)();
        return true;
      },
    );
    await expect(drenarStdout('Smoke e2e')).resolves.toBeUndefined();
    expect(escritos).toEqual(['Smoke e2e\n']);
  });

  it('aguarda o callback de descarga antes de resolver', async () => {
    let descargas = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation(
      (...resto: Array<unknown>): boolean => {
        const retorno: unknown = resto.find((valor) => typeof valor === 'function');
        queueMicrotask(() => {
          descargas += 1;
          (retorno as unknown as () => void)();
        });
        return true;
      },
    );
    await drenarStdout('relatorio');
    expect(descargas).toBe(1);
  });
});
