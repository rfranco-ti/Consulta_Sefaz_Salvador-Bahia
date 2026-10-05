import { env } from '../../config/env.js';
import { TimeoutError } from '../../shared/errors/index.js';

export type LiberacaoSemaforo = () => void;

interface EsperaSemaforo {
  portal: string;
  concluida: boolean;
  cancelarExpiracao: () => void;
  resolver: (liberacao: LiberacaoSemaforo) => void;
  rejeitar: (erro: Error) => void;
}

export class Semaforo {
  private emUsoGlobal = 0;
  private emUsoPorPortal = new Map<string, number>();
  private fila: EsperaSemaforo[] = [];

  constructor(
    private readonly limiteGlobal: number,
    private readonly limitePorPortal: number,
  ) {}

  adquirir(portal: string, timeoutMs: number): Promise<LiberacaoSemaforo> {
    return new Promise<LiberacaoSemaforo>((resolver, rejeitar) => {
      const espera: EsperaSemaforo = {
        portal,
        concluida: false,
        cancelarExpiracao: () => undefined,
        resolver,
        rejeitar,
      };
      espera.cancelarExpiracao = this.agendarExpiracao(espera, portal, timeoutMs);
      this.fila.push(espera);
      this.atenderFila();
    });
  }

  private agendarExpiracao(
    espera: EsperaSemaforo,
    portal: string,
    timeoutMs: number,
  ): () => void {
    const temporizador = setTimeout(() => {
      this.expirar(espera, portal, timeoutMs);
    }, timeoutMs);
    return () => {
      clearTimeout(temporizador);
    };
  }

  private expirar(espera: EsperaSemaforo, portal: string, timeoutMs: number): void {
    if (espera.concluida) {
      return;
    }
    espera.concluida = true;
    this.remover(espera);
    espera.rejeitar(
      new TimeoutError(
        `Tempo esgotado após ${timeoutMs}ms aguardando vaga do semáforo para o portal "${portal}"`,
      ),
    );
  }

  private atenderFila(): void {
    let proxima = this.proximaElegivel();
    while (proxima !== undefined) {
      this.remover(proxima);
      this.ocupar(proxima.portal);
      this.entregar(proxima);
      proxima = this.proximaElegivel();
    }
  }

  private proximaElegivel(): EsperaSemaforo | undefined {
    return this.fila.find((espera) => this.cabe(espera.portal));
  }

  private cabe(portal: string): boolean {
    if (this.emUsoGlobal >= this.limiteGlobal) {
      return false;
    }
    return (this.emUsoPorPortal.get(portal) ?? 0) < this.limitePorPortal;
  }

  private remover(espera: EsperaSemaforo): void {
    this.fila = this.fila.filter((pendente) => pendente !== espera);
  }

  private ocupar(portal: string): void {
    this.emUsoGlobal += 1;
    this.emUsoPorPortal.set(portal, (this.emUsoPorPortal.get(portal) ?? 0) + 1);
  }

  private entregar(espera: EsperaSemaforo): void {
    espera.concluida = true;
    espera.cancelarExpiracao();
    let liberada = false;
    espera.resolver(() => {
      if (liberada) {
        return;
      }
      liberada = true;
      this.devolver(espera.portal);
    });
  }

  private devolver(portal: string): void {
    this.emUsoGlobal -= 1;
    const restantes = (this.emUsoPorPortal.get(portal) ?? 1) - 1;
    if (restantes <= 0) {
      this.emUsoPorPortal.delete(portal);
    } else {
      this.emUsoPorPortal.set(portal, restantes);
    }
    this.atenderFila();
  }
}

export function criarSemaforo(): Semaforo {
  return new Semaforo(env.SEMAFORO_GLOBAL, env.SEMAFORO_POR_PORTAL);
}
