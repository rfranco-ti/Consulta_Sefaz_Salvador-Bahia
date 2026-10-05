import { InternalError } from '../../shared/errors/index.js';
import type { JobWorker } from './job.types.js';

export class JobWorkerImpl implements JobWorker {
  async iniciar(): Promise<void> {
    throw new InternalError('JobWorker.iniciar nao implementado (Fase 3)');
  }

  async parar(): Promise<void> {
    throw new InternalError('JobWorker.parar nao implementado (Fase 3)');
  }
}
