import { ValidationError } from '../shared/errors/index.js';

export function ehViolacaoUnica(erro: unknown): boolean {
  if (typeof erro !== 'object' || erro === null) {
    return false;
  }
  if (
    'code' in erro &&
    (erro.code === 'SQLITE_CONSTRAINT_UNIQUE' || erro.code === 'SQLITE_CONSTRAINT_PRIMARYKEY')
  ) {
    return true;
  }
  return (
    'message' in erro &&
    typeof erro.message === 'string' &&
    erro.message.includes('UNIQUE constraint failed')
  );
}

export function ehViolacaoChaveEstrangeira(erro: unknown): boolean {
  if (typeof erro !== 'object' || erro === null) {
    return false;
  }
  if ('code' in erro && erro.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return true;
  }
  return (
    'message' in erro &&
    typeof erro.message === 'string' &&
    erro.message.includes('FOREIGN KEY constraint failed')
  );
}

export function exigirTexto(valor: string, mensagem: string): void {
  if (valor.trim().length === 0) {
    throw new ValidationError(mensagem);
  }
}

export function agoraIso(): string {
  return new Date().toISOString();
}
