import { pino, type Logger } from 'pino';
import { env } from '../../config/env.js';

export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  base: { app: 'api-sefaz-ssa' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'apiKey',
      'ADMIN_KEY',
      'ENCRYPTION_KEY',
      'cookies',
    ],
    censor: '[REDACTED]',
  },
});
