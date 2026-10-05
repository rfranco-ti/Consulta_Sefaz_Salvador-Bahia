import { z } from 'zod';

/**
 * Configuracao de ambiente (.env). Validada uma unica vez na importacao.
 * Falhar aqui e proposital: configuracao invalida nao deve subir o servidor.
 */
const schema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  /** Chave administrativa (gestao de API keys). Opcional so em dev/test. */
  ADMIN_KEY: z.string().min(16).optional(),
  /** AES-256-GCM (64 hex) para o storageState das sessoes. */
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY deve ter 64 caracteres hex')

    .optional(),

  SESSION_TTL_HORAS: z.coerce.number().positive().default(12),

  SEMAFORO_GLOBAL: z.coerce.number().int().positive().default(5),
  SEMAFORO_POR_PORTAL: z.coerce.number().int().positive().default(1),
  FILA_TIMEOUT_SEG: z.coerce.number().positive().default(90),

  DATABASE_PATH: z.string().default('./data/app.sqlite'),
  STORAGE_DIR: z.string().default('./storage'),
});

export const env = schema.parse(process.env);

export type Env = typeof env;
