import type { TipoAutomacao } from '../../automations/registry.js';
import { InternalError } from '../../shared/errors/index.js';
import type { Executor } from './job.types.js';

const executores = new Map<TipoAutomacao, Executor>();

export function registrarExecutor(tipo: TipoAutomacao, executor: Executor): void {
  executores.set(tipo, executor);
}

export function removerExecutor(tipo: TipoAutomacao): void {
  executores.delete(tipo);
}

export function limparExecutores(): void {
  executores.clear();
}

export function obterExecutor(tipo: TipoAutomacao): Executor {
  const executor = executores.get(tipo);
  if (executor !== undefined) {
    return executor;
  }
  return async () => {
    throw new InternalError(`Automação "${tipo}" ainda não possui executor implementado`);
  };
}
