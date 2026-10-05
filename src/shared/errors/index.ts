/**
 * Hierarquia de erros (.docs/ERROR_HANDLING.md).
 *
 * `AppError` vira resposta HTTP padrao no error handler do Fastify:
 *   { error: { code, message, details? } }
 * Stack trace nunca vai ao cliente.
 */

export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: unknown;
  /** Etapa da automacao quando aplicavel (diagnostico). */
  readonly etapa?: string;

  constructor(
    code: string,
    message: string,
    httpStatus = 500,
    options?: { details?: unknown; etapa?: string; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = options?.details;
    this.etapa = options?.etapa;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_ERROR', message, 400, { details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'API key ausente ou invalida') {
    super('UNAUTHORIZED', message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Operacao nao permitida') {
    super('FORBIDDEN', message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Recurso nao encontrado') {
    super('NOT_FOUND', message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super('CONFLICT', message, 409);
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Limite de requisicoes atingido') {
    super('RATE_LIMITED', message, 429);
  }
}

/** Falha na automacao (portal, seletor, parse). */
export class AutomationError extends AppError {
  constructor(message: string, options?: { etapa?: string; cause?: unknown }) {
    super('AUTOMACAO_ERROR', message, 500, options);
  }
}

/** + etapa/URL para diagnostico. */
export class EtapaError extends AutomationError {
  constructor(etapa: string, message: string, options?: { cause?: unknown }) {
    super(`[${etapa}] ${message}`, { ...options, etapa });
  }
}

export class CaptchaError extends AutomationError {
  constructor(message = 'Captcha nao resolvido apos tentativas') {
    super(message);
  }
}

export class BrowserError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('BROWSER_ERROR', message, 500, options);
  }
}

export class TimeoutError extends AppError {
  constructor(message: string) {
    super('TIMEOUT', message, 504);
  }
}

/** Portal/servico externo fora do ar ou resposta invalida. */
export class ExternalServiceError extends AppError {
  constructor(message: string) {
    super('EXTERNAL_SERVICE_ERROR', message, 502);
  }
}

export class DatabaseError extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('DATABASE_ERROR', message, 500, options);
  }
}

export class InternalError extends AppError {
  constructor(message = 'Erro interno', options?: { cause?: unknown }) {
    super('INTERNAL_ERROR', message, 500, options);
  }
}

/** Converte qualquer rejeicao em AppError (mapeia, nao mascara). */
export function paraAppError(erro: unknown): AppError {
  if (erro instanceof AppError) return erro;
  if (erro instanceof Error) {
    // Erros de timeout do Node/Playwright viram TimeoutError.
    if (erro.name === 'TimeoutError' || erro.name === 'TimeoutErrorImpl') {
      return new TimeoutError(erro.message);
    }
    return new InternalError(erro.message, { cause: erro });
  }
  return new InternalError(String(erro));
}
