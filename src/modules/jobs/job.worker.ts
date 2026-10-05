import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { PORTAL_DO_TIPO } from '../../automations/registry.js';
import { MAX_TENTATIVAS } from '../../config/constants.js';
import { env } from '../../config/env.js';
import { ExecucoesRepository, type Execucao } from '../../database/index.js';
import { agoraIso } from '../../database/sqlite-erros.js';
import {
  BrowserError,
  ConflictError,
  ExternalServiceError,
  NotFoundError,
  TimeoutError,
  paraAppError,
  type AppError,
} from '../../shared/errors/index.js';
import { logger as loggerPadrao } from '../../shared/logger/index.js';
import { obterBrowserService } from '../browser/browser.service.js';
import type { BrowserSession } from '../browser/browser.types.js';
import { obterExecutor } from './executor.js';
import type {
  ExecucaoStatus,
  JobWorker,
  OpcoesWorker,
  ResultadoExecutor,
} from './job.types.js';
import { obterCanalProgresso } from './progresso.js';
import { criarSemaforo, type LiberacaoSemaforo, type Semaforo } from './semaphore.js';

const INTERVALO_SONDAGEM_PADRAO_MS = 50;
const INTERVALO_VARREDURA_PADRAO_MS = 15000;
const TIMEOUT_SEMAFORO_PADRAO_MS = 30000;
const BACKOFF_BASE_MS = 100;
const BACKOFF_TETO_MS = 2000;
const CODIGO_REINICIO = 'REINICIO';
const CODIGO_CANCELADA = 'CANCELLED';

function esperarReal(ms: number): Promise<void> {
  return new Promise<void>((resolver) => {
    setTimeout(resolver, ms);
  });
}

function backoffPadrao(tentativa: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (tentativa - 1), BACKOFF_TETO_MS);
}

function ehRecuperavel(erro: AppError): boolean {
  return (
    erro instanceof TimeoutError ||
    erro instanceof ExternalServiceError ||
    erro instanceof BrowserError
  );
}

export class WorkerFila implements JobWorker {
  private readonly banco: Database.Database;
  private readonly repo: ExecucoesRepository;
  private readonly semaforo: Semaforo;
  private readonly criarSessao: (portal: string) => Promise<BrowserSession>;
  private readonly maxTentativas: number;
  private readonly backoffMs: (tentativa: number) => number;
  private readonly esperar: (ms: number) => Promise<void>;
  private readonly agoraMs: () => number;
  private readonly filaTimeoutSeg: number;
  private readonly intervaloSondagemMs: number;
  private readonly intervaloVarreduraMs: number;
  private readonly timeoutSemaforoMs: number;
  private readonly logger: Logger;
  private readonly canceladas = new Set<string>();
  private readonly emAndamento = new Set<Promise<void>>();
  private cicloAtual: Promise<void> | null = null;
  private temporizadorVarredura: NodeJS.Timeout | null = null;
  private rodando = false;

  constructor(opcoes: OpcoesWorker) {
    this.banco = opcoes.banco;
    this.repo = new ExecucoesRepository(opcoes.banco);
    this.semaforo = opcoes.semaforo ?? criarSemaforo();
    this.criarSessao =
      opcoes.criarSessao ?? ((portal: string) => obterBrowserService().criarSessao({ portal }));
    this.maxTentativas = opcoes.maxTentativas ?? MAX_TENTATIVAS;
    this.backoffMs = opcoes.backoffMs ?? backoffPadrao;
    this.esperar = opcoes.esperar ?? esperarReal;
    this.agoraMs = opcoes.agoraMs ?? Date.now;
    this.filaTimeoutSeg = opcoes.filaTimeoutSeg ?? env.FILA_TIMEOUT_SEG;
    this.intervaloSondagemMs = opcoes.intervaloSondagemMs ?? INTERVALO_SONDAGEM_PADRAO_MS;
    this.intervaloVarreduraMs = opcoes.intervaloVarreduraMs ?? INTERVALO_VARREDURA_PADRAO_MS;
    this.timeoutSemaforoMs = opcoes.timeoutSemaforoMs ?? TIMEOUT_SEMAFORO_PADRAO_MS;
    this.logger = opcoes.logger ?? loggerPadrao;
  }

  async iniciar(): Promise<void> {
    if (this.rodando) {
      return;
    }
    this.rodando = true;
    this.recuperar();
    this.expirarFila();
    this.cicloAtual = this.ciclo().catch((erro: unknown) => {
      this.logger.error({ err: erro }, 'Ciclo do worker de execuções foi interrompido');
    });
    if (this.intervaloVarreduraMs > 0) {
      const temporizador = setInterval(() => {
        this.executarVarredura();
      }, this.intervaloVarreduraMs);
      temporizador.unref();
      this.temporizadorVarredura = temporizador;
    }
  }

  async parar(): Promise<void> {
    this.rodando = false;
    if (this.temporizadorVarredura !== null) {
      clearInterval(this.temporizadorVarredura);
      this.temporizadorVarredura = null;
    }
    const ciclo = this.cicloAtual;
    this.cicloAtual = null;
    if (ciclo !== null) {
      await ciclo;
    }
    if (this.emAndamento.size > 0) {
      await Promise.all(Array.from(this.emAndamento));
    }
  }

  async executarProxima(): Promise<Execucao | null> {
    const proxima = this.repo.reservarProximaPendente();
    if (proxima === null) {
      return null;
    }
    return this.processar(proxima);
  }

  async processar(execucao: Execucao): Promise<Execucao> {
    const atual = this.repo.buscarPorId(execucao.id);
    if (atual === null) {
      throw new NotFoundError('Execução não encontrada');
    }
    if (atual.status !== 'RUNNING') {
      return atual;
    }
    const inicio = this.agoraMs();
    const portal = PORTAL_DO_TIPO[atual.tipo];
    this.publicar(atual.id, 'RUNNING', null, atual.attempts);
    let liberar: LiberacaoSemaforo | null = null;
    try {
      try {
        liberar = await this.semaforo.adquirir(portal, this.timeoutSemaforoMs);
      } catch (erro) {
        return this.falhar(atual.id, paraAppError(erro), inicio);
      }
      return await this.tentarComRetry(atual, portal, inicio);
    } finally {
      if (liberar !== null) {
        liberar();
      }
      this.canceladas.delete(execucao.id);
    }
  }

  cancelar(id: string): Execucao {
    try {
      const final = this.repo.cancelar(id);
      this.publicarFinal(id, 'CANCELLED', null, final.attempts);
      return final;
    } catch (erro) {
      if (erro instanceof ConflictError) {
        const atual = this.repo.buscarPorId(id);
        if (atual !== null && atual.status === 'RUNNING') {
          this.canceladas.add(id);
        }
      }
      throw erro;
    }
  }

  recuperar(): number {
    return this.repo.marcarInterrompidasComoFalha(
      CODIGO_REINICIO,
      'Execução interrompida pelo reinício da API',
    );
  }

  expirarFila(agora?: number): number {
    const referencia = agora ?? this.agoraMs();
    const limite = new Date(referencia - this.filaTimeoutSeg * 1000).toISOString();
    const ids = this.banco.transaction((): string[] => {
      const linhas = this.banco
        .prepare<[string], { id: string }>(
          "SELECT id FROM execucoes WHERE status = 'PENDING' AND criado_em < ?",
        )
        .all(limite);
      if (linhas.length === 0) {
        return [];
      }
      const erro = JSON.stringify({
        code: 'TIMEOUT',
        message: `Execução excedeu o tempo máximo de espera na fila (${this.filaTimeoutSeg}s)`,
      });
      this.banco
        .prepare<[string, string, string]>(
          "UPDATE execucoes SET status = 'FAILED', error = ?, finalizado_em = ? WHERE status = 'PENDING' AND criado_em < ?",
        )
        .run(erro, agoraIso(), limite);
      return linhas.map((linha) => linha.id);
    })();
    for (const id of ids) {
      const atual = this.repo.buscarPorId(id);
      this.publicarFinal(id, 'FAILED', null, atual?.attempts ?? 0);
    }
    return ids.length;
  }

  private async ciclo(): Promise<void> {
    while (this.rodando) {
      let proxima: Execucao | null = null;
      try {
        proxima = this.repo.reservarProximaPendente();
      } catch (erro) {
        this.logger.error({ err: erro }, 'Falha ao reservar próxima execução pendente');
        await this.esperar(this.intervaloSondagemMs);
        continue;
      }
      if (proxima === null) {
        await this.esperar(this.intervaloSondagemMs);
        continue;
      }
      this.despachar(proxima);
    }
  }

  private despachar(execucao: Execucao): void {
    let tarefa: Promise<void>;
    tarefa = this.executarSemFalhar(execucao, () => {
      this.emAndamento.delete(tarefa);
    });
    this.emAndamento.add(tarefa);
  }

  private async executarSemFalhar(execucao: Execucao, aoConcluir: () => void): Promise<void> {
    try {
      await this.processar(execucao);
    } catch (erro) {
      this.logger.error(
        { err: erro, execucaoId: execucao.id },
        'Falha inesperada ao processar execução',
      );
    } finally {
      aoConcluir();
    }
  }

  private async tentarComRetry(
    execucao: Execucao,
    portal: string,
    inicio: number,
  ): Promise<Execucao> {
    const executor = obterExecutor(execucao.tipo);
    let tentativa = 0;
    while (true) {
      if (this.canceladas.has(execucao.id)) {
        return this.falharCancelada(execucao.id, inicio);
      }
      tentativa += 1;
      this.repo.incrementarTentativas(execucao.id);
      this.publicar(execucao.id, 'RUNNING', null, tentativa);
      let sessao: BrowserSession | null = null;
      try {
        sessao = await this.criarSessao(portal);
      } catch (erro) {
        const tipado = paraAppError(erro);
        if (ehRecuperavel(tipado) && tentativa <= this.maxTentativas) {
          await this.esperar(this.backoffMs(tentativa));
          continue;
        }
        return this.falhar(execucao.id, tipado, inicio);
      }
      try {
        const resultado = await executor({ ...execucao, attempts: tentativa }, sessao);
        if (this.canceladas.has(execucao.id)) {
          return this.falharCancelada(execucao.id, inicio);
        }
        return this.concluir(execucao.id, resultado, inicio);
      } catch (erro) {
        const tipado = paraAppError(erro);
        if (this.canceladas.has(execucao.id)) {
          return this.falharCancelada(execucao.id, inicio);
        }
        if (ehRecuperavel(tipado) && tentativa <= this.maxTentativas) {
          await this.esperar(this.backoffMs(tentativa));
          continue;
        }
        return this.falhar(execucao.id, tipado, inicio);
      } finally {
        if (sessao !== null) {
          await this.liberarSessao(sessao, execucao.id);
        }
      }
    }
  }

  private concluir(id: string, resultado: ResultadoExecutor, inicio: number): Execucao {
    const duracao = Math.max(0, this.agoraMs() - inicio);
    try {
      const final = this.repo.marcarSucesso(id, JSON.stringify(resultado), duracao);
      this.publicarFinal(id, 'SUCCESS', null, final.attempts);
      return final;
    } catch (erro) {
      return this.resolverConflitoFinal(id, erro);
    }
  }

  private falhar(id: string, erro: AppError, inicio: number): Execucao {
    const duracao = Math.max(0, this.agoraMs() - inicio);
    try {
      const final = this.repo.marcarFalha(
        id,
        { code: erro.code, message: erro.message, etapa: erro.etapa },
        duracao,
      );
      this.publicarFinal(id, 'FAILED', null, final.attempts);
      return final;
    } catch (conflito) {
      return this.resolverConflitoFinal(id, conflito);
    }
  }

  private falharCancelada(id: string, inicio: number): Execucao {
    const duracao = Math.max(0, this.agoraMs() - inicio);
    try {
      const final = this.repo.marcarFalha(
        id,
        { code: CODIGO_CANCELADA, message: 'Execução cancelada durante o processamento' },
        duracao,
      );
      this.publicarFinal(id, 'FAILED', null, final.attempts);
      return final;
    } catch (conflito) {
      return this.resolverConflitoFinal(id, conflito);
    }
  }

  private resolverConflitoFinal(id: string, erro: unknown): Execucao {
    if (!(erro instanceof ConflictError)) {
      throw erro;
    }
    const atual = this.repo.buscarPorId(id);
    if (atual === null) {
      throw new NotFoundError('Execução não encontrada');
    }
    this.logger.warn(
      { execucaoId: id, status: atual.status },
      'Execução mudou de estado durante a conclusão; mantendo estado atual',
    );
    this.publicarFinal(id, atual.status, null, atual.attempts);
    return atual;
  }

  private executarVarredura(): void {
    try {
      this.expirarFila();
    } catch (erro) {
      this.logger.error({ err: erro }, 'Falha na varredura de tempo limite da fila');
    }
  }

  private async liberarSessao(sessao: BrowserSession, execucaoId: string): Promise<void> {
    try {
      await sessao.liberar();
    } catch (erro) {
      this.logger.warn({ err: erro, execucaoId }, 'Falha ao liberar sessão do navegador');
    }
  }

  private publicar(
    execucaoId: string,
    status: ExecucaoStatus,
    posicaoFila: number | null,
    tentativa: number,
  ): void {
    obterCanalProgresso().publicar({ execucaoId, status, posicaoFila, tentativa });
  }

  private publicarFinal(
    execucaoId: string,
    status: ExecucaoStatus,
    posicaoFila: number | null,
    tentativa: number,
  ): void {
    obterCanalProgresso().publicarFinal({ execucaoId, status, posicaoFila, tentativa });
  }
}

let instancia: WorkerFila | null = null;

export async function iniciarWorker(opcoes: OpcoesWorker): Promise<WorkerFila> {
  if (instancia !== null) {
    throw new ConflictError('Worker de execuções já está em execução');
  }
  const worker = new WorkerFila(opcoes);
  instancia = worker;
  await worker.iniciar();
  return worker;
}

export async function pararWorker(): Promise<void> {
  const worker = instancia;
  instancia = null;
  if (worker !== null) {
    await worker.parar();
  }
}

export function obterWorker(): WorkerFila | null {
  return instancia;
}
