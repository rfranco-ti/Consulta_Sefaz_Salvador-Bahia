import type Database from 'better-sqlite3';
import { ehTipoAutomacao, type TipoAutomacao } from '../../automations/registry.js';
import type { ExecucaoStatus } from '../../modules/automation/automation.types.js';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/index.js';
import { agoraIso, ehViolacaoChaveEstrangeira, ehViolacaoUnica, exigirTexto } from '../sqlite-erros.js';

export interface Execucao {
  id: string;
  tipo: TipoAutomacao;
  status: ExecucaoStatus;
  payload: string;
  payloadBruto: string;
  resultado: string | null;
  erro: string | null;
  attempts: number;
  apiKeyId: string;
  ticket: number;
  cacheVersion: number;
  posicaoFila: number | null;
  criadoEm: string;
  iniciadoEm: string | null;
  finalizadoEm: string | null;
  duracaoMs: number | null;
}

export interface InserirExecucaoInput {
  id: string;
  tipo: string;
  payload: string;
  payloadBruto: string;
  apiKeyId: string;
  cacheVersion?: number;
}

export interface ErroExecucao {
  code: string;
  message: string;
  etapa?: string;
}

interface ExecucaoLinha {
  id: string;
  tipo: string;
  status: string;
  payload: string;
  payload_bruto: string;
  resultado: string | null;
  error: string | null;
  attempts: number;
  api_key_id: string;
  ticket: number;
  cache_version: number;
  posicao_fila: number | null;
  criado_em: string;
  iniciado_em: string | null;
  finalizado_em: string | null;
  duracao_ms: number | null;
}

const COLUNAS =
  'id, tipo, status, payload, payload_bruto, resultado, error, attempts, api_key_id, ticket, cache_version, posicao_fila, criado_em, iniciado_em, finalizado_em, duracao_ms';

function paraExecucao(linha: ExecucaoLinha): Execucao {
  return {
    id: linha.id,
    tipo: linha.tipo as TipoAutomacao,
    status: linha.status as ExecucaoStatus,
    payload: linha.payload,
    payloadBruto: linha.payload_bruto,
    resultado: linha.resultado,
    erro: linha.error,
    attempts: linha.attempts,
    apiKeyId: linha.api_key_id,
    ticket: linha.ticket,
    cacheVersion: linha.cache_version,
    posicaoFila: linha.posicao_fila,
    criadoEm: linha.criado_em,
    iniciadoEm: linha.iniciado_em,
    finalizadoEm: linha.finalizado_em,
    duracaoMs: linha.duracao_ms,
  };
}

export class ExecucoesRepository {
  constructor(private readonly banco: Database.Database) {}

  inserir(input: InserirExecucaoInput): Execucao {
    exigirTexto(input.id, 'Identificador da execução é obrigatório');
    exigirTexto(input.payload, 'Payload da execução é obrigatório');
    exigirTexto(input.payloadBruto, 'Payload bruto da execução é obrigatório');
    exigirTexto(input.apiKeyId, 'Chave de API da execução é obrigatória');
    if (!ehTipoAutomacao(input.tipo)) {
      throw new ValidationError(`Tipo de automação inválido: ${input.tipo}`);
    }
    const cacheVersion = input.cacheVersion ?? 1;
    const criadoEm = agoraIso();
    try {
      const gravar = this.banco.transaction(() => {
        const anterior = this.banco
          .prepare<[], { ticket: number | null }>('SELECT MAX(ticket) AS ticket FROM execucoes')
          .get();
        const ticket = (anterior?.ticket ?? 0) + 1;
        this.banco
          .prepare<[string, string, string, string, string, string, number, number, string]>(
            'INSERT INTO execucoes (id, tipo, status, payload, payload_bruto, resultado, error, attempts, api_key_id, ticket, cache_version, posicao_fila, criado_em, iniciado_em, finalizado_em, duracao_ms) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?, NULL, ?, NULL, NULL, NULL)',
          )
          .run(
            input.id,
            input.tipo,
            'PENDING',
            input.payload,
            input.payloadBruto,
            input.apiKeyId,
            ticket,
            cacheVersion,
            criadoEm,
          );
      });
      gravar();
    } catch (erro) {
      if (ehViolacaoUnica(erro)) {
        throw new ConflictError('Execução já cadastrada');
      }
      if (ehViolacaoChaveEstrangeira(erro)) {
        throw new ValidationError('Chave de API não encontrada para a execução');
      }
      throw erro;
    }
    return this.buscarPorIdOuFalhar(input.id);
  }

  buscarPorId(id: string): Execucao | null {
    const linha = this.banco
      .prepare<[string], ExecucaoLinha>(`SELECT ${COLUNAS} FROM execucoes WHERE id = ?`)
      .get(id);
    return linha === undefined ? null : paraExecucao(linha);
  }

  reservarProximaPendente(): Execucao | null {
    const reservar = this.banco.transaction((): Execucao | null => {
      for (let tentativa = 0; tentativa < 5; tentativa += 1) {
        const candidata = this.banco
          .prepare<[], { id: string }>(
            "SELECT id FROM execucoes WHERE status = 'PENDING' ORDER BY ticket ASC, criado_em ASC LIMIT 1",
          )
          .get();
        if (candidata === undefined) {
          return null;
        }
        const info = this.banco
          .prepare<[string, string]>(
            "UPDATE execucoes SET status = 'RUNNING', iniciado_em = ? WHERE id = ? AND status = 'PENDING'",
          )
          .run(agoraIso(), candidata.id);
        if (info.changes === 1) {
          return this.buscarPorIdOuFalhar(candidata.id);
        }
      }
      return null;
    });
    return reservar();
  }

  posicaoNaFila(id: string): number | null {
    const atual = this.buscarPorId(id);
    if (atual === null || atual.status !== 'PENDING') {
      return null;
    }
    const linha = this.banco
      .prepare<[number], { total: number }>(
        "SELECT COUNT(*) AS total FROM execucoes WHERE status = 'PENDING' AND ticket < ?",
      )
      .get(atual.ticket);
    return (linha?.total ?? 0) + 1;
  }

  contarPendentes(): number {
    const linha = this.banco
      .prepare<[], { total: number }>(
        "SELECT COUNT(*) AS total FROM execucoes WHERE status = 'PENDING'",
      )
      .get();
    return linha?.total ?? 0;
  }

  cancelar(id: string): Execucao {
    const info = this.banco
      .prepare<[string, string]>(
        "UPDATE execucoes SET status = 'CANCELLED', finalizado_em = ? WHERE id = ? AND status = 'PENDING'",
      )
      .run(agoraIso(), id);
    if (info.changes === 0) {
      const atual = this.buscarPorIdOuFalhar(id);
      throw new ConflictError(
        `Somente execuções pendentes podem ser canceladas (status atual: ${atual.status})`,
      );
    }
    return this.buscarPorIdOuFalhar(id);
  }

  marcarSucesso(id: string, resultado: string, duracaoMs?: number): Execucao {
    exigirTexto(resultado, 'Resultado da execução é obrigatório');
    const info = this.banco
      .prepare<[string, string, number | null, string]>(
        "UPDATE execucoes SET status = 'SUCCESS', resultado = ?, finalizado_em = ?, duracao_ms = ? WHERE id = ? AND status = 'RUNNING'",
      )
      .run(resultado, agoraIso(), duracaoMs ?? null, id);
    if (info.changes === 0) {
      this.lancarTransicaoInvalida(id, 'concluída');
    }
    return this.buscarPorIdOuFalhar(id);
  }

  marcarFalha(id: string, erro: ErroExecucao, duracaoMs?: number): Execucao {
    exigirTexto(erro.code, 'Código do erro da execução é obrigatório');
    exigirTexto(erro.message, 'Mensagem do erro da execução é obrigatória');
    const info = this.banco
      .prepare<[string, string, number | null, string]>(
        "UPDATE execucoes SET status = 'FAILED', error = ?, finalizado_em = ?, duracao_ms = ? WHERE id = ? AND status = 'RUNNING'",
      )
      .run(JSON.stringify(erro), agoraIso(), duracaoMs ?? null, id);
    if (info.changes === 0) {
      this.lancarTransicaoInvalida(id, 'marcada como falha');
    }
    return this.buscarPorIdOuFalhar(id);
  }

  incrementarTentativas(id: string): number {
    const info = this.banco
      .prepare<[string]>('UPDATE execucoes SET attempts = attempts + 1 WHERE id = ?')
      .run(id);
    if (info.changes === 0) {
      throw new NotFoundError('Execução não encontrada');
    }
    return this.buscarPorIdOuFalhar(id).attempts;
  }

  marcarInterrompidasComoFalha(codigo: string, mensagem: string): number {
    exigirTexto(codigo, 'Código do erro da execução é obrigatório');
    exigirTexto(mensagem, 'Mensagem do erro da execução é obrigatória');
    const info = this.banco
      .prepare<[string, string]>(
        "UPDATE execucoes SET status = 'FAILED', error = ?, finalizado_em = ? WHERE status = 'RUNNING'",
      )
      .run(JSON.stringify({ code: codigo, message: mensagem }), agoraIso());
    return info.changes;
  }

  adicionarParticipante(execucaoId: string, apiKeyId: string): void {
    exigirTexto(execucaoId, 'Identificador da execução é obrigatório');
    exigirTexto(apiKeyId, 'Identificador da chave de API é obrigatório');
    try {
      this.banco
        .prepare<[string, string]>(
          'INSERT INTO execucoes_participantes (execucao_id, api_key_id) VALUES (?, ?)',
        )
        .run(execucaoId, apiKeyId);
    } catch (erro) {
      if (ehViolacaoUnica(erro)) {
        return;
      }
      if (ehViolacaoChaveEstrangeira(erro)) {
        throw new ValidationError('Execução ou chave de API não encontrada para participação');
      }
      throw erro;
    }
  }

  listarParticipantes(execucaoId: string): string[] {
    const linhas = this.banco
      .prepare<[string], { api_key_id: string }>(
        'SELECT api_key_id FROM execucoes_participantes WHERE execucao_id = ? ORDER BY api_key_id ASC',
      )
      .all(execucaoId);
    return linhas.map((linha) => linha.api_key_id);
  }

  private buscarPorIdOuFalhar(id: string): Execucao {
    const execucao = this.buscarPorId(id);
    if (execucao === null) {
      throw new NotFoundError('Execução não encontrada');
    }
    return execucao;
  }

  private lancarTransicaoInvalida(id: string, verbo: string): never {
    const atual = this.buscarPorIdOuFalhar(id);
    throw new ConflictError(
      `Execução não pode ser ${verbo} a partir do status ${atual.status}`,
    );
  }
}
