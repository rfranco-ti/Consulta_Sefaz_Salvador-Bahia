import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecucoesRepository } from '../../src/database/index.js';
import { AutomationService } from '../../src/modules/automation/automation.service.js';
import type { IniciarExecucaoInput } from '../../src/modules/automation/automation.types.js';
import { CanalProgresso } from '../../src/modules/jobs/progresso.js';
import { criarBancoTemporario, criarChaveApi } from './database-helpers.js';

const CNPJ_VALIDO = '12345678000190';

function entrada(apiKeyId: string): IniciarExecucaoInput {
  return {
    tipo: 'sefaz-bahia',
    params: { cnpj: CNPJ_VALIDO },
    artefatos: 'nenhum',
    inline: false,
    forceRefresh: false,
    apiKeyId,
  };
}

beforeEach(() => {
  new CanalProgresso().limpar();
});

afterEach(() => {
  new CanalProgresso().limpar();
});

describe('smoke segunda roda marca CACHE', () => {
  it('consultar após conclusão ao vivo popula o cache da próxima execução', async () => {
    const tmp = criarBancoTemporario();
    try {
      const chaveA = criarChaveApi(tmp.banco).id;
      const chaveB = criarChaveApi(tmp.banco).id;
      const armazenamento = mkdtempSync(join(tmpdir(), 'smoke-cache-'));
      const canal = new CanalProgresso();
      const servico = new AutomationService({
        banco: tmp.banco,
        canal,
        diretorioArmazenamento: armazenamento,
      });
      const primeira = await servico.iniciar(entrada(chaveA));
      expect(primeira.cache).toMatchObject({ hit: false });
      new ExecucoesRepository(tmp.banco).reservarProximaPendente();
      new ExecucoesRepository(tmp.banco).marcarSucesso(
        primeira.execucaoId,
        JSON.stringify({ sucesso: true, dados: { situacao: 'ativa' } }),
        12900,
      );
      const lida = await servico.consultar(primeira.execucaoId, chaveA);
      expect(lida.status).toBe('SUCCESS');
      const segunda = await servico.iniciar(entrada(chaveB));
      expect(segunda.status).toBe('SUCCESS');
      expect(segunda.cache).toMatchObject({ hit: true });
      expect(segunda.resultado?.dados).toEqual({ situacao: 'ativa' });
    } finally {
      tmp.limpar();
    }
  });

  it('sucesso falso do portal nunca vira CACHE', async () => {
    const tmp = criarBancoTemporario();
    try {
      const chaveA = criarChaveApi(tmp.banco).id;
      const chaveB = criarChaveApi(tmp.banco).id;
      const armazenamento = mkdtempSync(join(tmpdir(), 'smoke-cache-'));
      const canal = new CanalProgresso();
      const servico = new AutomationService({
        banco: tmp.banco,
        canal,
        diretorioArmazenamento: armazenamento,
      });
      const primeira = await servico.iniciar(entrada(chaveA));
      new ExecucoesRepository(tmp.banco).reservarProximaPendente();
      new ExecucoesRepository(tmp.banco).marcarSucesso(
        primeira.execucaoId,
        JSON.stringify({ sucesso: false, dados: { cnpjBuscado: CNPJ_VALIDO } }),
        13000,
      );
      const lida = await servico.consultar(primeira.execucaoId, chaveA);
      expect(lida.status).toBe('SUCCESS');
      const segunda = await servico.iniciar(entrada(chaveB));
      expect(segunda.status).toBe('PENDING');
      expect(segunda.cache).toMatchObject({ hit: false });
    } finally {
      tmp.limpar();
    }
  });
});
