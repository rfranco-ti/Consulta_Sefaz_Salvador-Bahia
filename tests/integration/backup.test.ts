import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { executarBackup, gerarNomeBackup } from '../../src/modules/higiene/backup.service.js';
import { criarBancoTemporario, criarChaveApi } from './database-helpers.js';

function criarDestino(): { diretorio: string; limpar: () => void } {
  const diretorio = mkdtempSync(join(tmpdir(), 'backup-destino-'));
  return {
    diretorio,
    limpar: () => {
      rmSync(diretorio, { recursive: true, force: true });
    },
  };
}

describe('backup do banco', () => {
  it('gera nome compacto a partir da data', () => {
    expect(gerarNomeBackup(new Date('2026-01-02T03:04:05.000Z'))).toBe('app-20260102T030405Z.sqlite');
  });

  it('cria um sqlite válido com os dados de origem', async () => {
    const temp = criarBancoTemporario();
    const destino = criarDestino();
    try {
      criarChaveApi(temp.banco);
      const resultado = await executarBackup({
        origem: temp.arquivo,
        diretorioDestino: destino.diretorio,
        agora: () => new Date('2026-06-15T12:00:00.000Z'),
      });
      expect(resultado.arquivo).toBe(join(destino.diretorio, 'app-20260615T120000Z.sqlite'));
      expect(existsSync(resultado.arquivo)).toBe(true);
      expect(resultado.removidos).toEqual([]);
      const copia = new Database(resultado.arquivo, { readonly: true });
      try {
        const total = copia.prepare('SELECT COUNT(*) AS total FROM api_keys').get() as { total: number };
        expect(total.total).toBe(1);
      } finally {
        copia.close();
      }
    } finally {
      destino.limpar();
      temp.limpar();
    }
  });

  it('mantém apenas os últimos 5 backups', async () => {
    const temp = criarBancoTemporario();
    const destino = criarDestino();
    try {
      criarChaveApi(temp.banco);
      const base = new Date('2026-06-15T12:00:00.000Z').getTime();
      let removidos: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        const resultado = await executarBackup({
          origem: temp.arquivo,
          diretorioDestino: destino.diretorio,
          agora: () => new Date(base + i * 60_000),
        });
        removidos = resultado.removidos;
      }
      const arquivos = readdirSync(destino.diretorio).sort();
      expect(arquivos).toHaveLength(5);
      expect(arquivos[0]).toBe('app-20260615T120200Z.sqlite');
      expect(arquivos[4]).toBe('app-20260615T120600Z.sqlite');
      expect(removidos.length).toBeGreaterThan(0);
      expect(existsSync(join(destino.diretorio, 'app-20260615T120000Z.sqlite'))).toBe(false);
      expect(existsSync(join(destino.diretorio, 'app-20260615T120100Z.sqlite'))).toBe(false);
    } finally {
      destino.limpar();
      temp.limpar();
    }
  });

  it('falha quando o arquivo de origem não existe', async () => {
    const destino = criarDestino();
    try {
      await expect(
        executarBackup({
          origem: join(destino.diretorio, 'inexistente.sqlite'),
          diretorioDestino: destino.diretorio,
        }),
      ).rejects.toThrow('não encontrado');
    } finally {
      destino.limpar();
    }
  });
});
