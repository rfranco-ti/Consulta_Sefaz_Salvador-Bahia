import { pino, type Logger, type LoggerOptions } from 'pino';
import { env } from '../../config/env.js';

export const APIKEY_REDACTED = '[REDACTED]';

/**
 * Substitui apenas o VALOR do parametro `apikey` na query string pela
 * marca de redacao, preservando o restante da URL (caminho e demais
 * parametros) verbatim.
 *
 * Cobre o parametro em qualquer posicao (primeiro, meio ou ultimo) e
 * valores percent-encoded (que nunca contem `&` ou `#` literais, entao
 * sao consumidos por inteiro). Nomes parecidos (`apikey2`, `xapikey`)
 * nao sao tocados.
 */
export function redactApikeyFromUrl(url: string): string {
  return url.replace(/([?&]apikey=)([^&#]*)/gi, `$1${APIKEY_REDACTED}`);
}

export interface RequisicaoSerializavel {
  method?: unknown;
  url?: unknown;
  headers?: Record<string, unknown>;
  host?: unknown;
  ip?: unknown;
  socket?: { remotePort?: unknown } | null;
}

/**
 * Serializador `req` compativel com o formato padrao do Fastify
 * (method, url, version, host, remoteAddress, remotePort), com duas
 * diferencas de seguranca:
 * - `url` sai com o valor de `?apikey=` redigido;
 * - `headers` e repassado para que o `redact` do pino continue
 *   censurando `authorization` e `x-api-key`.
 */
export function serializeRequest(req: RequisicaoSerializavel): {
  method: unknown;
  url: unknown;
  version: unknown;
  host: unknown;
  remoteAddress: unknown;
  remotePort: unknown;
  headers: unknown;
} {
  const headers = (req.headers ?? {}) as Record<string, unknown>;
  return {
    method: req.method,
    url:
      typeof req.url === 'string' ? redactApikeyFromUrl(req.url) : req.url,
    version: headers['accept-version'],
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket ? req.socket.remotePort : undefined,
    headers: req.headers,
  };
}

const redactPaths = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'apiKey',
  'ADMIN_KEY',
  'ENCRYPTION_KEY',
  'cookies',
];

export const loggerOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  base: { app: 'api-sefaz-ssa' },
  redact: {
    paths: redactPaths,
    censor: APIKEY_REDACTED,
  },
  serializers: {
    req: serializeRequest,
  },
};

export const logger: Logger = pino(loggerOptions);
