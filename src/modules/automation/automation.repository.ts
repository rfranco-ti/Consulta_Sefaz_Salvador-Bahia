import type Database from 'better-sqlite3';
import { ehTipoAutomacao, type TipoAutomacao } from '../../automations/registry.js';
import { ExecucoesRepository } from '../../database/repositories/execucoes.repository.js';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/index.js';
import {
  agoraIso,
  ehViolacaoChaveEstrangeira,
  ehViolacaoUnica,
  exigirTexto,
} from '../../database/sqlite-erros.js';
import { normalizarPayload } from './automation.cache.js';
import type { ArtefatosOpcao } from './automation.types.js';

export type StatusExecucao = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';

export interface ExecucaoRegistro {
  id: string;
  tipo: TipoAutomacao;
  status: StatusExecucao;
  ticket: number;
  payload: string;
  payloadBruto: string;
  resultado: string | null;
  erro: string | null;
  attempts: number;
  apiKeyId: string;
  idempotencyKey: string | null;
  cacheVersion: number;
  criadoEm: string;
  iniciadoEm: string | null;
  finalizadoEm: string | null;
  duracaoMs: number | null;
}

export interface CriarExecucaoInput {
  id: string;
  tipo: TipoAutomacao;
  payload: string;
  payloadBruto: string;
  apiKeyId: string;
  cacheVersion?: number;
  idempotencyKey?: string;
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
  idempotency_key: string | null;
  ticket: number;
  cache_version: number;
  criado_em: string;
  iniciado_em: string | null;
  finalizado_em: string | null;
  duracao_ms: number | null;
}

const COLUNAS =
  'id, tipo, status, payload, payload_bruto, resultado, error, attempts, api_key_id, idempotency_key, ticket, cache_version, criado_em, iniciado_em, finalizado_em, duracao_ms';

function paraRegistro(linha: ExecucaoLinha): ExecucaoRegistro {
  if (!ehTipoAutomacao(linha.tipo)) {
    throw new ValidationError(`Tipo de automação inválido: ${linha.tipo}`);
  }
  return {
    id: linha.id,
    tipo: linha.tipo,
    status: linha.status as StatusExecucao,
    ticket: linha.ticket,
    payload: linha.payload,
    payloadBruto: linha.payload_bruto,
    resultado: linha.resultado,
    erro: linha.error,
    attempts: linha.attempts,
    apiKeyId: linha.api_key_id,
    idempotencyKey: linha.idempotency_key,
    cacheVersion: linha.cache_version,
    criadoEm: linha.criado_em,
    iniciadoEm: linha.iniciado_em,
    finalizadoEm: linha.finalizado_em,
    duracaoMs: linha.duracao_ms,
  };
}

export function normalizarPayloadArmazenado(payload: string): string | null {
  let bruto: unknown;
  try {
    bruto = JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) {
    return null;
  }
  const copia = { ...(bruto as Record<string, unknown>) };
  delete copia['artefatos'];
  return normalizarPayload(copia);
}

export function unirArtefatos(atual: ArtefatosOpcao, pedido: ArtefatosOpcao): ArtefatosOpcao {
  if (atual === pedido) {
    return atual;
  }
  if (atual === 'ambos' || pedido === 'ambos') {
    return 'ambos';
  }
  if (atual === 'nenhum') {
    return pedido;
  }
  if (pedido === 'nenhum') {
    return atual;
  }
  return 'ambos';
}

function lerArtefatos(payload: string): ArtefatosOpcao {
  try {
    const bruto = JSON.parse(payload) as { artefatos?: unknown };
    const valor = bruto.artefatos;
    if (valor === 'nenhum' || valor === 'pdf' || valor === 'print' || valor === 'ambos') {
      return valor;
    }
  } catch {
    return 'nenhum';
  }
  return 'nenhum';
}

export class AutomationRepository {
  private readonly banco: Database.Database;
  private readonly execucoes: ExecucoesRepository;

  constructor(banco: Database.Database) {
    this.banco = banco;
    this.execucoes = new ExecucoesRepository(banco);
  }

  criar(input: CriarExecucaoInput): ExecucaoRegistro {
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
          .prepare<[string, string, string, string, string, string, number, number, string, string | null]>(
            'INSERT INTO execucoes (id, tipo, status, payload, payload_bruto, resultado, error, attempts, api_key_id, ticket, cache_version, posicao_fila, criado_em, iniciado_em, finalizado_em, duracao_ms, idempotency_key) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)',
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
            input.idempotencyKey ?? null,
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
    return this.porId(input.id);
  }

  criarConcluida(input: CriarExecucaoInput, resultado: string): ExecucaoRegistro {
    exigirTexto(input.id, 'Identificador da execução é obrigatório');
    exigirTexto(input.payload, 'Payload da execução é obrigatório');
    exigirTexto(input.payloadBruto, 'Payload bruto da execução é obrigatório');
    exigirTexto(input.apiKeyId, 'Chave de API da execução é obrigatória');
    exigirTexto(resultado, 'Resultado da execução é obrigatório');
    if (!ehTipoAutomacao(input.tipo)) {
      throw new ValidationError(`Tipo de automação inválido: ${input.tipo}`);
    }
    const criadoEm = agoraIso();
    try {
      const gravar = this.banco.transaction(() => {
        const anterior = this.banco
          .prepare<[], { ticket: number | null }>('SELECT MAX(ticket) AS ticket FROM execucoes')
          .get();
        const ticket = (anterior?.ticket ?? 0) + 1;
        this.banco
          .prepare<[string, string, string, string, string, string, string, number, number, string, string, string, string | null]>(
            'INSERT INTO execucoes (id, tipo, status, payload, payload_bruto, resultado, error, attempts, api_key_id, ticket, cache_version, posicao_fila, criado_em, iniciado_em, finalizado_em, duracao_ms, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, NULL, ?, ?, ?, 0, ?)',
          )
          .run(
            input.id,
            input.tipo,
            'SUCCESS',
            input.payload,
            input.payloadBruto,
            resultado,
            input.apiKeyId,
            ticket,
            input.cacheVersion ?? 1,
            criadoEm,
            criadoEm,
            criadoEm,
            input.idempotencyKey ?? null,
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
    return this.porId(input.id);
  }

  porId(id: string): ExecucaoRegistro {
    const linha = this.banco
      .prepare<[string], ExecucaoLinha>(`SELECT ${COLUNAS} FROM execucoes WHERE id = ?`)
      .get(id);
    if (linha === undefined) {
      throw new NotFoundError('Execução não encontrada');
    }
    return paraRegistro(linha);
  }

  porIdempotencia(apiKeyId: string, chave: string): ExecucaoRegistro | null {
    const linha = this.banco
      .prepare<[string, string], ExecucaoLinha>(
        `SELECT ${COLUNAS} FROM execucoes WHERE api_key_id = ? AND idempotency_key = ?`,
      )
      .get(apiKeyId, chave);
    return linha === undefined ? null : paraRegistro(linha);
  }

  ativaPorParametros(tipo: TipoAutomacao, payloadNormalizado: string): ExecucaoRegistro | null {
    const linhas = this.banco
      .prepare<[string], { id: string; payload: string }>(
        "SELECT id, payload FROM execucoes WHERE tipo = ? AND status IN ('PENDING', 'RUNNING') ORDER BY ticket ASC",
      )
      .all(tipo);
    for (const linha of linhas) {
      if (normalizarPayloadArmazenado(linha.payload) === payloadNormalizado) {
        return this.porId(linha.id);
      }
    }
    return null;
  }

  contarAtivasPorChave(apiKeyId: string): number {
    const linha = this.banco
      .prepare<[string], { total: number }>(
        "SELECT COUNT(*) AS total FROM execucoes WHERE api_key_id = ? AND status IN ('PENDING', 'RUNNING')",
      )
      .get(apiKeyId);
    return linha?.total ?? 0;
  }

  elevarArtefatos(id: string, pedido: ArtefatosOpcao): void {
    const atual = this.porId(id);
    if (atual.status !== 'PENDING') {
      return;
    }
    const vigente = lerArtefatos(atual.payload);
    const uniao = unirArtefatos(vigente, pedido);
    if (uniao === vigente) {
      return;
    }
    let bruto: Record<string, unknown>;
    try {
      bruto = JSON.parse(atual.payload) as Record<string, unknown>;
    } catch {
      return;
    }
    const proximo = JSON.stringify({ ...bruto, artefatos: uniao });
    this.banco
      .prepare<[string, string]>("UPDATE execucoes SET payload = ? WHERE id = ? AND status = 'PENDING'")
      .run(proximo, id);
  }

  adicionarParticipante(execucaoId: string, apiKeyId: string): void {
    this.execucoes.adicionarParticipante(execucaoId, apiKeyId);
  }

  participantes(execucaoId: string): string[] {
    return this.execucoes.listarParticipantes(execucaoId);
  }

  posicaoNaFila(id: string): number | null {
    return this.execucoes.posicaoNaFila(id);
  }

  cancelar(id: string): ExecucaoRegistro {
    this.execucoes.cancelar(id);
    return this.porId(id);
  }

  marcarSucesso(id: string, resultado: string, duracaoMs?: number): ExecucaoRegistro {
    this.execucoes.marcarSucesso(id, resultado, duracaoMs);
    return this.porId(id);
  }

  marcarFalha(
    id: string,
    erro: { code: string; message: string; etapa?: string },
    duracaoMs?: number,
  ): ExecucaoRegistro {
    this.execucoes.marcarFalha(id, erro, duracaoMs);
    return this.porId(id);
  }

  historico(apiKeyId: string): ExecucaoRegistro[] {
    const linhas = this.banco
      .prepare<[string], ExecucaoLinha>(
        `SELECT ${COLUNAS} FROM execucoes WHERE api_key_id = ? ORDER BY criado_em DESC, ticket DESC`,
      )
      .all(apiKeyId);
    return linhas.map((linha) => paraRegistro(linha));
  }
}
