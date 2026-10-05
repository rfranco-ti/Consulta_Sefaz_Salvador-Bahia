import type { EventoProgresso, OuvinteProgresso } from './job.types.js';

export class CanalProgresso {
  private readonly ouvintes = new Map<string, Set<OuvinteProgresso>>();

  observar(execucaoId: string, ouvinte: OuvinteProgresso): () => void {
    this.conjuntoDe(execucaoId).add(ouvinte);
    let ativo = true;
    return () => {
      if (!ativo) {
        return;
      }
      ativo = false;
      this.remover(execucaoId, ouvinte);
    };
  }

  publicar(evento: EventoProgresso): void {
    const conjunto = this.ouvintes.get(evento.execucaoId);
    if (conjunto === undefined) {
      return;
    }
    for (const ouvinte of Array.from(conjunto)) {
      ouvinte(evento);
    }
  }

  publicarFinal(evento: EventoProgresso): void {
    this.publicar(evento);
    this.ouvintes.delete(evento.execucaoId);
  }

  contar(execucaoId?: string): number {
    if (execucaoId !== undefined) {
      return this.ouvintes.get(execucaoId)?.size ?? 0;
    }
    let total = 0;
    for (const conjunto of this.ouvintes.values()) {
      total += conjunto.size;
    }
    return total;
  }

  limpar(): void {
    this.ouvintes.clear();
  }

  private conjuntoDe(execucaoId: string): Set<OuvinteProgresso> {
    const existente = this.ouvintes.get(execucaoId);
    if (existente !== undefined) {
      return existente;
    }
    const conjunto = new Set<OuvinteProgresso>();
    this.ouvintes.set(execucaoId, conjunto);
    return conjunto;
  }

  private remover(execucaoId: string, ouvinte: OuvinteProgresso): void {
    const conjunto = this.ouvintes.get(execucaoId);
    if (conjunto === undefined) {
      return;
    }
    conjunto.delete(ouvinte);
    if (conjunto.size === 0) {
      this.ouvintes.delete(execucaoId);
    }
  }
}

let canal: CanalProgresso | null = null;

export function obterCanalProgresso(): CanalProgresso {
  if (canal === null) {
    canal = new CanalProgresso();
  }
  return canal;
}

export function observarProgresso(
  execucaoId: string,
  ouvinte: OuvinteProgresso,
): () => void {
  return obterCanalProgresso().observar(execucaoId, ouvinte);
}

export function publicarProgresso(evento: EventoProgresso): void {
  obterCanalProgresso().publicar(evento);
}
