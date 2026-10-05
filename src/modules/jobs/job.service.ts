import { InternalError } from '../../shared/errors/index.js';

export class JobService {
  async adquirir(_portal: string, _timeoutSeg: number): Promise<() => void> {
    throw new InternalError('JobService.adquirir nao implementado (Fase 3)');
  }
}
