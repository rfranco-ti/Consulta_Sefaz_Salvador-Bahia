import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TipoAutomacao } from '../../src/automations/registry.js';
import { ExecucoesRepository } from '../../src/database/index.js';
import { CacheConsultas } from '../../src/modules/automation/automation.cache.js';
import { AutomationService } from '../../src/modules/automation/automation.service.js';
import type { IniciarExecucaoInput } from '../../src/modules/automation/automation.types.js';
import { CanalProgresso } from '../../src/modules/jobs/progresso.js';
import {
  ConflictError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from '../../src/shared/errors/index.js';
import { criarBancoTemporario, criarChaveApi } from './database-helpers.js';

const CNPJ_VALIDO = '12345678000190';
const CHAVE_IDEMPOTENTE = 'idempotencia-teste-01';

interface Mundo {
  banco: Database.Database;
  servico: AutomationService;
  canal: CanalProgresso;
  chaveA: string;
  chaveB: string;
  armazenamento: string;
  limpar: () => void;
}

function montarMundo(): Mundo {
  const tmp = criarBancoTemporario();
  const chaveA = criarChaveApi(tmp.banco).id;
  const chaveB = criarChaveApi(tmp.banco).id;
  const armazenamento = mkdtempSync(join(tmpdir(), 'armazenamento-teste-'));
  const canal = new CanalProgresso();
  const servico = new AutomationService({
    banco: tmp.banco,
    canal,
    diretorioArmazenamento: armazenamento,
  });
  return {
    banco: tmp.banco,
    servico,
    canal,
    chaveA,
    chaveB,
    armazenamento,
    limpar: tmp.limpar,
  };
}

function entrada(
  parcial?: Partial<IniciarExecucaoInput> & { apiKeyId: string },
): IniciarExecucaoInput {
  return {
    tipo: 'sefaz-bahia',
    params: { cnpj: CNPJ_VALIDO },
    artefatos: 'nenhum',
    inline: false,
    forceRefresh: false,
    apiKeyId: parcial?.apiKeyId ?? '',
    ...(parcial ?? {}),
  };
}

function reservarComoRunning(banco: Database.Database): void {
  new ExecucoesRepository(banco).reservarProximaPendente();
}

beforeEach(() => {
  new CanalProgresso().limpar();
});

afterEach(() => {
  new CanalProgresso().limpar();
});

describe('migration da coluna idempotency_key', () => {
  it('aplica a migração 002 e expõe a coluna idempotency_key', () => {
    const { banco, limpar } = criarBancoTemporario();
    try {
      const colunas = banco
        .prepare<[], { name: string }>('SELECT name FROM pragma_table_info(?)')
        .all('execucoes');
      expect(colunas.map((c) => c.name)).toContain('idempotency_key');
      const aplicadas = banco
        .prepare<[], { nome: string }>('SELECT nome FROM schema_migrations ORDER BY nome ASC')
        .all();
      expect(aplicadas.map((a) => a.nome)).toContain('002-idempotency-key');
    } finally {
      limpar();
    }
  });
});

describe('AutomationService.iniciar', () => {
  it('rejeita parâmetros inválidos com erro de validação em português', async () => {
    const mundo = montarMundo();
    try {
      const falha = await mundo.servico
        .iniciar(entrada({ apiKeyId: mundo.chaveA, params: { cnpj: '123' } }))
        .then(
          () => null,
          (erro: unknown) => erro,
        );
      expect(falha).toBeInstanceOf(ValidationError);
      expect((falha as ValidationError).code).toBe('VALIDATION_ERROR');
      expect((falha as ValidationError).httpStatus).toBe(400);
    } finally {
      mundo.limpar();
    }
  });

  it('rejeita tipo desconhecido com erro de validação em português', async () => {
    const mundo = montarMundo();
    try {
      const falha = await mundo.servico
        .iniciar(entrada({ apiKeyId: mundo.chaveA, tipo: 'portal-fantasma' as TipoAutomacao }))
        .then(
          () => null,
          (erro: unknown) => erro,
        );
      expect(falha).toBeInstanceOf(ValidationError);
      expect((falha as ValidationError).httpStatus).toBe(400);
    } finally {
      mundo.limpar();
    }
  });

  it('enfileira execução pendente com posição de fila', async () => {
    const mundo = montarMundo();
    try {
      const resposta = await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveA }));
      expect(resposta.status).toBe('PENDING');
      expect(resposta.execucaoId).toMatch(/^exe_/);
      expect(resposta.posicaoFila).toBe(1);
      expect(resposta.cache).toMatchObject({ hit: false });
    } finally {
      mundo.limpar();
    }
  });

  it('normaliza o CNPJ mascarado para a mesma chave de voo', async () => {
    const mundo = montarMundo();
    try {
      const primeira = await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveA }));
      const segunda = await mundo.servico.iniciar(
        entrada({ apiKeyId: mundo.chaveB, params: { cnpj: '12.345.678/0001-90' } }),
      );
      expect(segunda.execucaoId).toBe(primeira.execucaoId);
      expect(segunda.status).toBe('PENDING');
    } finally {
      mundo.limpar();
    }
  });

  it('aplica o teto de uma execução ativa por chave', async () => {
    const mundo = montarMundo();
    try {
      await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveA }));
      const falha = await mundo.servico
        .iniciar(
          entrada({ apiKeyId: mundo.chaveA, params: { cnpj: '98765432000198' } }),
        )
        .then(
          () => null,
          (erro: unknown) => erro,
        );
      expect(falha).toBeInstanceOf(RateLimitedError);
      expect((falha as RateLimitedError).code).toBe('RATE_LIMITED');
      expect((falha as RateLimitedError).httpStatus).toBe(429);
    } finally {
      mundo.limpar();
    }
  });

  it('não conta a junção ao voo como execução ativa da chave', async () => {
    const mundo = montarMundo();
    try {
      await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveA }));
      const juncao = await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveB }));
      expect(juncao.status).toBe('PENDING');
      const propria = await mundo.servico.iniciar(
        entrada({ apiKeyId: mundo.chaveB, params: { cnpj: '98765432000198' } }),
      );
      expect(propria.status).toBe('PENDING');
    } finally {
      mundo.limpar();
    }
  });

  it('registra o participante na junção ao voo', async () => {
    const mundo = montarMundo();
    try {
      const primeira = await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveA }));
      await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveB }));
      const participantes = new ExecucoesRepository(mundo.banco)
        .listarParticipantes(primeira.execucaoId);
      expect(participantes).toContain(mundo.chaveB);
    } finally {
      mundo.limpar();
    }
  });

  it('eleva os artefatos do voo para a união do pedido', async () => {
    const mundo = montarMundo();
    try {
      const primeira = await mundo.servico.iniciar(
        entrada({ apiKeyId: mundo.chaveA, artefatos: 'pdf' }),
      );
      await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveB, artefatos: 'print' }));
      const linha = new ExecucoesRepository(mundo.banco).buscarPorId(primeira.execucaoId);
      const payload = JSON.parse(linha?.payload ?? '{}') as { artefatos?: string };
      expect(payload.artefatos).toBe('ambos');
    } finally {
      mundo.limpar();
    }
  });

  it('reapresenta a mesma execução para a mesma chave de idempotência', async () => {
    const mundo = montarMundo();
    try {
      const primeira = await mundo.servico.iniciar(
        entrada({ apiKeyId: mundo.chaveA, idempotencyKey: CHAVE_IDEMPOTENTE }),
      );
      const segunda = await mundo.servico.iniciar(
        entrada({
          apiKeyId: mundo.chaveA,
          artefatos: 'pdf',
          idempotencyKey: CHAVE_IDEMPOTENTE,
        }),
      );
      expect(segunda.execucaoId).toBe(primeira.execucaoId);
      const total = mundo.banco
        .prepare<[], { total: number }>('SELECT COUNT(*) AS total FROM execucoes')
        .get()?.total;
      expect(total).toBe(1);
    } finally {
      mundo.limpar();
    }
  });

  it('rejeita a mesma chave de idempotência com parâmetros divergentes', async () => {
    const mundo = montarMundo();
    try {
      await mundo.servico.iniciar(
        entrada({ apiKeyId: mundo.chaveA, idempotencyKey: CHAVE_IDEMPOTENTE }),
      );
      const falha = await mundo.servico
        .iniciar(
          entrada({
            apiKeyId: mundo.chaveA,
            tipo: 'ficha-cadastral',
            params: { cnpj: CNPJ_VALIDO },
            idempotencyKey: CHAVE_IDEMPOTENTE,
          }),
        )
        .then(
          () => null,
          (erro: unknown) => erro,
        );
      expect(falha).toBeInstanceOf(ConflictError);
      expect((falha as ConflictError).httpStatus).toBe(409);
    } finally {
      mundo.limpar();
    }
  });

  it('serve o acerto de cache como sucesso sem enfileirar', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveA }));
      reservarComoRunning(mundo.banco);
      await mundo.servico.finalizar(criada.execucaoId, {
        sucesso: true,
        dados: { situacao: 'ativa' },
      });
      const acerto = await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveB }));
      expect(acerto.status).toBe('SUCCESS');
      expect(acerto.cache).toMatchObject({ hit: true });
      expect(acerto.resultado?.dados).toEqual({ situacao: 'ativa' });
      expect(acerto.execucaoId).not.toBe(criada.execucaoId);
    } finally {
      mundo.limpar();
    }
  });

  it('pula o cache com forceRefresh', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveA }));
      reservarComoRunning(mundo.banco);
      await mundo.servico.finalizar(criada.execucaoId, {
        sucesso: true,
        dados: { situacao: 'ativa' },
      });
      const resposta = await mundo.servico.iniciar(
        entrada({ apiKeyId: mundo.chaveB, forceRefresh: true }),
      );
      expect(resposta.status).toBe('PENDING');
      expect(resposta.cache).toMatchObject({ hit: false });
    } finally {
      mundo.limpar();
    }
  });
});

describe('AutomationService.consultar', () => {
  it('responde 404 para execução de outra chave', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveA }));
      const falha = await mundo.servico.consultar(criada.execucaoId, mundo.chaveB).then(
        () => null,
        (erro: unknown) => erro,
      );
      expect(falha).toBeInstanceOf(NotFoundError);
      expect((falha as NotFoundError).httpStatus).toBe(404);
    } finally {
      mundo.limpar();
    }
  });

  it('responde 404 para execução inexistente', async () => {
    const mundo = montarMundo();
    try {
      const falha = await mundo.servico.consultar('exe_inexistente', mundo.chaveA).then(
        () => null,
        (erro: unknown) => erro,
      );
      expect(falha).toBeInstanceOf(NotFoundError);
    } finally {
      mundo.limpar();
    }
  });

  it('permite ao participante acompanhar o voo', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveA }));
      await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveB }));
      const resposta = await mundo.servico.consultar(criada.execucaoId, mundo.chaveB);
      expect(resposta.status).toBe('PENDING');
    } finally {
      mundo.limpar();
    }
  });

  it('mapeia sucesso com documentos e duração', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveA }));
      reservarComoRunning(mundo.banco);
      await mundo.servico.finalizar(criada.execucaoId, {
        sucesso: true,
        dados: { situacao: 'ativa' },
        pdfBase64: Buffer.from('conteudo-pdf').toString('base64'),
      }, 95);
      const resposta = await mundo.servico.consultar(criada.execucaoId, mundo.chaveA);
      expect(resposta.status).toBe('SUCCESS');
      expect(resposta.resultado?.dados).toEqual({ situacao: 'ativa' });
      expect(resposta.resultado?.documentos).toHaveLength(1);
      expect(resposta.resultado?.documentos?.[0]?.url).toMatch(/^\/v1\/documentos\/doc_/);
      expect(resposta.duracaoMs).toEqual(expect.any(Number));
    } finally {
      mundo.limpar();
    }
  });

  it('mapeia falha com código e mensagem', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveA }));
      reservarComoRunning(mundo.banco);
      await mundo.servico.falhar(criada.execucaoId, new Error('Portal fora do ar'));
      const resposta = await mundo.servico.consultar(criada.execucaoId, mundo.chaveA);
      expect(resposta.status).toBe('FAILED');
      expect(resposta.error?.message).toBe('Portal fora do ar');
    } finally {
      mundo.limpar();
    }
  });
});

describe('AutomationService.cancelar', () => {
  it('cancela execução pendente', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveA }));
      await mundo.servico.cancelar(criada.execucaoId, mundo.chaveA);
      const resposta = await mundo.servico.consultar(criada.execucaoId, mundo.chaveA);
      expect(resposta.status).toBe('CANCELLED');
    } finally {
      mundo.limpar();
    }
  });

  it('rejeita cancelamento de execução em andamento com conflito', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveA }));
      reservarComoRunning(mundo.banco);
      const falha = await mundo.servico.cancelar(criada.execucaoId, mundo.chaveA).then(
        () => null,
        (erro: unknown) => erro,
      );
      expect(falha).toBeInstanceOf(ConflictError);
      expect((falha as ConflictError).httpStatus).toBe(409);
    } finally {
      mundo.limpar();
    }
  });

  it('responde 404 ao cancelar execução de outra chave', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveA }));
      const falha = await mundo.servico.cancelar(criada.execucaoId, mundo.chaveB).then(
        () => null,
        (erro: unknown) => erro,
      );
      expect(falha).toBeInstanceOf(NotFoundError);
    } finally {
      mundo.limpar();
    }
  });
});

describe('AutomationService.finalizar', () => {
  it('persiste documentos no armazenamento e remove os blobs do resultado', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveA }));
      reservarComoRunning(mundo.banco);
      const resposta = await mundo.servico.finalizar(
        criada.execucaoId,
        {
          sucesso: true,
          dados: { situacao: 'ativa' },
          mensagem: 'Consulta concluída',
          printBase64: Buffer.from('conteudo-print').toString('base64'),
          pdfBase64: Buffer.from('conteudo-pdf').toString('base64'),
        },
        120,
      );
      expect(resposta.status).toBe('SUCCESS');
      expect(resposta.duracaoMs).toBe(120);
      const linha = new ExecucoesRepository(mundo.banco).buscarPorId(criada.execucaoId);
      const resultado = JSON.parse(linha?.resultado ?? '{}') as Record<string, unknown>;
      expect(resultado['printBase64']).toBeUndefined();
      expect(resultado['pdfBase64']).toBeUndefined();
      expect(resposta.resultado?.documentos).toHaveLength(2);
      const leitura = new CacheConsultas({ banco: mundo.banco }).ler('sefaz-bahia', {
        cnpj: CNPJ_VALIDO,
      });
      expect(leitura?.dados).toMatchObject({ sucesso: true });
    } finally {
      mundo.limpar();
    }
  });

  it('conclui com sucesso sem cachear o achado negativo do portal', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveA }));
      reservarComoRunning(mundo.banco);
      const resposta = await mundo.servico.finalizar(criada.execucaoId, {
        sucesso: false,
        dados: { cnpjBuscado: CNPJ_VALIDO },
        mensagem: 'Inscrição não encontrada',
      });
      expect(resposta.status).toBe('SUCCESS');
      const leitura = new CacheConsultas({ banco: mundo.banco }).ler('sefaz-bahia', {
        cnpj: CNPJ_VALIDO,
      });
      expect(leitura).toBeNull();
    } finally {
      mundo.limpar();
    }
  });

  it('nunca cacheia a falha', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveA }));
      reservarComoRunning(mundo.banco);
      const resposta = await mundo.servico.falhar(criada.execucaoId, new Error('Timeout'));
      expect(resposta.status).toBe('FAILED');
      const leitura = new CacheConsultas({ banco: mundo.banco }).ler('sefaz-bahia', {
        cnpj: CNPJ_VALIDO,
      });
      expect(leitura).toBeNull();
    } finally {
      mundo.limpar();
    }
  });

  it('rejeita conclusão fora do estado em execução', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveA }));
      const falha = await mundo.servico
        .finalizar(criada.execucaoId, { sucesso: true, dados: {} })
        .then(
          () => null,
          (erro: unknown) => erro,
        );
      expect(falha).toBeInstanceOf(ConflictError);
    } finally {
      mundo.limpar();
    }
  });
});

describe('AutomationService.consultarSincrona', () => {
  it('retorna o acerto de cache sem aguardar', async () => {
    const mundo = montarMundo();
    try {
      const criada = await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveA }));
      reservarComoRunning(mundo.banco);
      await mundo.servico.finalizar(criada.execucaoId, {
        sucesso: true,
        dados: { situacao: 'ativa' },
      });
      const resposta = await mundo.servico.consultarSincrona({
        ...entrada({ apiKeyId: mundo.chaveB }),
        waitSeg: 5,
      });
      expect(resposta.status).toBe('SUCCESS');
      expect(resposta.cache).toMatchObject({ hit: true });
    } finally {
      mundo.limpar();
    }
  });

  it('aguarda a conclusão e retorna o sucesso', async () => {
    const mundo = montarMundo();
    try {
      const espera = mundo.servico.consultarSincrona({
        ...entrada({ apiKeyId: mundo.chaveA }),
        waitSeg: 5,
      });
      await Promise.resolve();
      const juncao = await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveB }));
      reservarComoRunning(mundo.banco);
      await mundo.servico.finalizar(juncao.execucaoId, {
        sucesso: true,
        dados: { situacao: 'ativa' },
      });
      const resposta = await espera;
      expect(resposta.status).toBe('SUCCESS');
      expect(resposta.resultado?.dados).toEqual({ situacao: 'ativa' });
    } finally {
      mundo.limpar();
    }
  });

  it('acorda quem aguarda quando a execução é cancelada', async () => {
    const mundo = montarMundo();
    try {
      const espera = mundo.servico.consultarSincrona({
        ...entrada({ apiKeyId: mundo.chaveA }),
        waitSeg: 5,
      });
      await Promise.resolve();
      const juncao = await mundo.servico.iniciar(entrada({ apiKeyId: mundo.chaveB }));
      await mundo.servico.cancelar(juncao.execucaoId, mundo.chaveA);
      const resposta = await espera;
      expect(resposta.status).toBe('CANCELLED');
    } finally {
      mundo.limpar();
    }
  });

  it('devolve pendente ao estourar o limite sem concluir', async () => {
    const mundo = montarMundo();
    try {
      const resposta = await mundo.servico.consultarSincrona({
        ...entrada({ apiKeyId: mundo.chaveA }),
        waitSeg: 0.05,
      });
      expect(resposta.status).toBe('PENDING');
      expect(resposta.cache).toMatchObject({ hit: false });
      expect(resposta.posicaoFila).toBe(1);
    } finally {
      mundo.limpar();
    }
  });

  it('rejeita espera fora do intervalo permitido', async () => {
    const mundo = montarMundo();
    try {
      const falha = await mundo.servico
        .consultarSincrona({ ...entrada({ apiKeyId: mundo.chaveA }), waitSeg: 61 })
        .then(
          () => null,
          (erro: unknown) => erro,
        );
      expect(falha).toBeInstanceOf(ValidationError);
    } finally {
      mundo.limpar();
    }
  });
});
