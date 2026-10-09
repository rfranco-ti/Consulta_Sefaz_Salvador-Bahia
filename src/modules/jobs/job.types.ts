import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { TipoAutomacao } from '../../automations/registry.js';
import type { Execucao } from '../../database/index.js';
import type { BrowserSession } from '../browser/browser.types.js';
import type { Semaforo } from './semaphore.js';

export type ExecucaoStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'CANCELLED';

export interface JobFila {
  id: string;
  tipo: TipoAutomacao;
  ticket: number;
  status: ExecucaoStatus;
  attempts: number;
  apiKeyId: string;
  criadoEm: string;
}

export interface JobWorker {
  iniciar(): Promise<void>;
  parar(): Promise<void>;
}

export type ResultadoExecutor = Record<string, unknown>;

export interface DepsExecutor {
  criarSessao(portal: string): Promise<BrowserSession>;
}

export type Executor = (
  execucao: Execucao,
  sessao: BrowserSession,
  deps?: DepsExecutor,
) => Promise<ResultadoExecutor>;

export interface EventoProgresso {
  execucaoId: string;
  status: ExecucaoStatus;
  posicaoFila: number | null;
  etapa?: string;
  tentativa?: number;
}

export type OuvinteProgresso = (evento: EventoProgresso) => void;

export interface OpcoesWorker {
  banco: Database.Database;
  semaforo?: Semaforo;
  criarSessao?: (portal: string) => Promise<BrowserSession>;
  maxTentativas?: number;
  backoffMs?: (tentativa: number) => number;
  esperar?: (ms: number) => Promise<void>;
  agoraMs?: () => number;
  filaTimeoutSeg?: number;
  intervaloSondagemMs?: number;
  intervaloVarreduraMs?: number;
  timeoutSemaforoMs?: number;
  logger?: Logger;
  /**
   * Chamado na conclusão de uma execução com o resultado bruto do robô.
   * Quando ausente, o worker persiste via `ExecucoesRepository.marcarSucesso`
   * (comportamento histórico). Em produção, o servidor injeta uma função que
   * delega para `AutomationService.finalizar`, que persiste artefatos em
   * disco/`documentos` e atualiza o cache. Erros `ConflictError` lançados pelo
   * callback seguem o mesmo caminho de `resolverConflitoFinal`.
   */
  aoConcluir?: (
    execucaoId: string,
    resultado: Record<string, unknown>,
    duracaoMs: number,
  ) => Promise<void> | void;
}
