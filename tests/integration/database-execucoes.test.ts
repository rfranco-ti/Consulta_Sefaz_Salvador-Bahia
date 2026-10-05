import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/database/client.js';
import { aplicarMigrations } from '../../src/database/migrations/index.js';
import { ExecucoesRepository } from '../../src/database/repositories/execucoes.repository.js';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../src/shared/errors/index.js';
import { criarBancoTemporario, criarChaveApi } from './database-helpers.js';

function montar(): { repo: ExecucoesRepository; apiKeyId: string; limpar: () => void } {
  const { banco, limpar } = criarBancoTemporario();
  const { id } = criarChaveApi(banco);
  return { repo: new ExecucoesRepository(banco), apiKeyId: id, limpar };
}

describe('execuções', () => {
  it('insere e busca com ticket sequencial e status pendente', () => {
    const { repo, apiKeyId, limpar } = montar();
    try {
      const primeira = repo.inserir({
        id: 'exe_1',
        tipo: 'sefaz-bahia',
        payload: '{"cnpj":"123"}',
        payloadBruto: '{"cnpj":"123"}',
        apiKeyId,
      });
      const segunda = repo.inserir({
        id: 'exe_2',
        tipo: 'cadin-salvador',
        payload: '{"cpf":"456"}',
        payloadBruto: '{"cpf":"456"}',
        apiKeyId,
      });
      expect(primeira.status).toBe('PENDING');
      expect(primeira.attempts).toBe(0);
      expect(primeira.ticket).toBe(1);
      expect(segunda.ticket).toBe(2);
      expect(primeira.resultado).toBeNull();
      expect(primeira.erro).toBeNull();
      const encontrada = repo.buscarPorId('exe_1');
      expect(encontrada?.payload).toBe('{"cnpj":"123"}');
      expect(encontrada?.tipo).toBe('sefaz-bahia');
      expect(encontrada?.apiKeyId).toBe(apiKeyId);
    } finally {
      limpar();
    }
  });

  it('buscar por id inexistente retorna nulo', () => {
    const { repo, limpar } = montar();
    try {
      expect(repo.buscarPorId('exe_inexistente')).toBeNull();
    } finally {
      limpar();
    }
  });

  it('rejeita tipo inválido e chave de API inexistente', () => {
    const { repo, apiKeyId, limpar } = montar();
    try {
      expect(() =>
        repo.inserir({
          id: 'exe_tipo_ruim',
          tipo: 'portal-inexistente',
          payload: '{}',
          payloadBruto: '{}',
          apiKeyId,
        }),
      ).toThrow(ValidationError);
      expect(() =>
        repo.inserir({
          id: 'exe_chave_ruim',
          tipo: 'sefaz-bahia',
          payload: '{}',
          payloadBruto: '{}',
          apiKeyId: 'key_inexistente',
        }),
      ).toThrow(ValidationError);
    } finally {
      limpar();
    }
  });

  it('rejeita id duplicado com erro de conflito', () => {
    const { repo, apiKeyId, limpar } = montar();
    try {
      repo.inserir({ id: 'exe_dup', tipo: 'sefaz-bahia', payload: '{}', payloadBruto: '{}', apiKeyId });
      expect(() =>
        repo.inserir({ id: 'exe_dup', tipo: 'sefaz-bahia', payload: '{}', payloadBruto: '{}', apiKeyId }),
      ).toThrow(ConflictError);
    } finally {
      limpar();
    }
  });

  it('reserva a próxima pendente em ordem FIFO e marca em andamento', () => {
    const { repo, apiKeyId, limpar } = montar();
    try {
      repo.inserir({ id: 'exe_a', tipo: 'sefaz-bahia', payload: '{}', payloadBruto: '{}', apiKeyId });
      repo.inserir({ id: 'exe_b', tipo: 'sefaz-bahia', payload: '{}', payloadBruto: '{}', apiKeyId });
      const primeira = repo.reservarProximaPendente();
      const segunda = repo.reservarProximaPendente();
      expect(primeira?.id).toBe('exe_a');
      expect(primeira?.status).toBe('RUNNING');
      expect(primeira?.iniciadoEm).not.toBeNull();
      expect(segunda?.id).toBe('exe_b');
      expect(repo.reservarProximaPendente()).toBeNull();
    } finally {
      limpar();
    }
  });

  it('duas conexões do mesmo arquivo reservam execuções distintas', () => {
    const bancoTemp = criarBancoTemporario();
    try {
      const { id } = criarChaveApi(bancoTemp.banco);
      const repoA = new ExecucoesRepository(bancoTemp.banco);
      const outraConexao = openDatabase(bancoTemp.arquivo);
      try {
        aplicarMigrations(outraConexao);
        const repoB = new ExecucoesRepository(outraConexao);
        repoA.inserir({ id: 'exe_c1', tipo: 'sefaz-bahia', payload: '{}', payloadBruto: '{}', apiKeyId: id });
        repoA.inserir({ id: 'exe_c2', tipo: 'sefaz-bahia', payload: '{}', payloadBruto: '{}', apiKeyId: id });
        const reservaA = repoA.reservarProximaPendente();
        const reservaB = repoB.reservarProximaPendente();
        expect(reservaA?.id).toBe('exe_c1');
        expect(reservaB?.id).toBe('exe_c2');
        expect(reservaA?.id).not.toBe(reservaB?.id);
      } finally {
        outraConexao.close();
      }
    } finally {
      bancoTemp.limpar();
    }
  });

  it('conclui e falha apenas a partir de em andamento', () => {
    const { repo, apiKeyId, limpar } = montar();
    try {
      repo.inserir({ id: 'exe_ok', tipo: 'sefaz-bahia', payload: '{}', payloadBruto: '{}', apiKeyId });
      repo.inserir({ id: 'exe_erro', tipo: 'sefaz-bahia', payload: '{}', payloadBruto: '{}', apiKeyId });
      repo.reservarProximaPendente();
      repo.reservarProximaPendente();
      const sucesso = repo.marcarSucesso('exe_ok', '{"situacao":"ativa"}', 1200);
      expect(sucesso.status).toBe('SUCCESS');
      expect(sucesso.resultado).toBe('{"situacao":"ativa"}');
      expect(sucesso.duracaoMs).toBe(1200);
      expect(sucesso.finalizadoEm).not.toBeNull();
      const falha = repo.marcarFalha(
        'exe_erro',
        { code: 'TIMEOUT', message: 'Portal demorou a responder', etapa: 'consulta' },
        900,
      );
      expect(falha.status).toBe('FAILED');
      expect(JSON.parse(falha.erro ?? '')).toEqual({
        code: 'TIMEOUT',
        message: 'Portal demorou a responder',
        etapa: 'consulta',
      });
      expect(() => repo.marcarSucesso('exe_ok', '{}')).toThrow(ConflictError);
      expect(() => repo.marcarFalha('exe_erro', { code: 'X', message: 'Y' })).toThrow(ConflictError);
    } finally {
      limpar();
    }
  });

  it('cancela apenas pendente e some da fila', () => {
    const { repo, apiKeyId, limpar } = montar();
    try {
      repo.inserir({ id: 'exe_x', tipo: 'sefaz-bahia', payload: '{}', payloadBruto: '{}', apiKeyId });
      const cancelada = repo.cancelar('exe_x');
      expect(cancelada.status).toBe('CANCELLED');
      expect(repo.reservarProximaPendente()).toBeNull();
      expect(() => repo.cancelar('exe_x')).toThrow(ConflictError);
      expect(() => repo.cancelar('exe_inexistente')).toThrow(NotFoundError);
      repo.inserir({ id: 'exe_y', tipo: 'sefaz-bahia', payload: '{}', payloadBruto: '{}', apiKeyId });
      repo.reservarProximaPendente();
      expect(() => repo.cancelar('exe_y')).toThrow(ConflictError);
    } finally {
      limpar();
    }
  });

  it('calcula posição na fila e conta pendentes', () => {
    const { repo, apiKeyId, limpar } = montar();
    try {
      repo.inserir({ id: 'exe_p1', tipo: 'sefaz-bahia', payload: '{}', payloadBruto: '{}', apiKeyId });
      repo.inserir({ id: 'exe_p2', tipo: 'sefaz-bahia', payload: '{}', payloadBruto: '{}', apiKeyId });
      repo.inserir({ id: 'exe_p3', tipo: 'sefaz-bahia', payload: '{}', payloadBruto: '{}', apiKeyId });
      expect(repo.posicaoNaFila('exe_p1')).toBe(1);
      expect(repo.posicaoNaFila('exe_p2')).toBe(2);
      expect(repo.posicaoNaFila('exe_p3')).toBe(3);
      expect(repo.contarPendentes()).toBe(3);
      repo.reservarProximaPendente();
      expect(repo.posicaoNaFila('exe_p1')).toBeNull();
      expect(repo.posicaoNaFila('exe_p2')).toBe(1);
      expect(repo.posicaoNaFila('exe_p3')).toBe(2);
      expect(repo.contarPendentes()).toBe(2);
      expect(repo.posicaoNaFila('exe_inexistente')).toBeNull();
    } finally {
      limpar();
    }
  });

  it('incrementa tentativas e falha interrompidas após reinício', () => {
    const { repo, apiKeyId, limpar } = montar();
    try {
      repo.inserir({ id: 'exe_r', tipo: 'sefaz-bahia', payload: '{}', payloadBruto: '{}', apiKeyId });
      expect(repo.incrementarTentativas('exe_r')).toBe(1);
      expect(repo.incrementarTentativas('exe_r')).toBe(2);
      expect(() => repo.incrementarTentativas('exe_inexistente')).toThrow(NotFoundError);
      repo.inserir({ id: 'exe_w', tipo: 'sefaz-bahia', payload: '{}', payloadBruto: '{}', apiKeyId });
      repo.reservarProximaPendente();
      repo.reservarProximaPendente();
      const afetadas = repo.marcarInterrompidasComoFalha(
        'REINICIO',
        'Execução interrompida pelo reinício da API',
      );
      expect(afetadas).toBe(2);
      expect(repo.buscarPorId('exe_r')?.status).toBe('FAILED');
      expect(repo.buscarPorId('exe_w')?.status).toBe('FAILED');
      expect(repo.marcarInterrompidasComoFalha('REINICIO', 'nada')).toBe(0);
    } finally {
      limpar();
    }
  });

  it('gerencia participantes com adesão idempotente', () => {
    const temp = criarBancoTemporario();
    try {
      const primeira = criarChaveApi(temp.banco);
      const segunda = criarChaveApi(temp.banco);
      const repo = new ExecucoesRepository(temp.banco);
      repo.inserir({
        id: 'exe_sf',
        tipo: 'sefaz-bahia',
        payload: '{}',
        payloadBruto: '{}',
        apiKeyId: primeira.id,
      });
      repo.adicionarParticipante('exe_sf', primeira.id);
      repo.adicionarParticipante('exe_sf', segunda.id);
      repo.adicionarParticipante('exe_sf', segunda.id);
      expect(repo.listarParticipantes('exe_sf')).toEqual([primeira.id, segunda.id].sort());
      expect(() => repo.adicionarParticipante('exe_inexistente', primeira.id)).toThrow(
        ValidationError,
      );
    } finally {
      temp.limpar();
    }
  });
});
