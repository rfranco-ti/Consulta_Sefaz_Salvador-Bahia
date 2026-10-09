import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const schema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  ADMIN_KEY: z.string().min(16).optional(),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY deve ter 64 caracteres hex')
    .optional(),

  SESSION_TTL_HORAS: z.coerce.number().positive().default(12),

  SEMAFORO_GLOBAL: z.coerce.number().int().positive().default(5),
  SEMAFORO_POR_PORTAL: z.coerce.number().int().positive().default(1),
  FILA_TIMEOUT_SEG: z.coerce.number().positive().default(90),

  RATE_LIMIT_POR_MINUTO: z.coerce.number().int().positive().default(60),

  DATABASE_PATH: z.string().default('./data/app.sqlite'),
  STORAGE_DIR: z.string().default('./storage'),

  HIGIENE_INTERVALO_MIN: z.coerce.number().int().positive().default(60),
  DOCUMENTOS_TTL_DIAS: z.coerce.number().int().positive().default(7),
});

export const env = schema.parse(process.env);

export type Env = typeof env;

// Raiz do projeto = diretório que contém o package.json (dois níveis acima de
// src/config/env.ts). Calculada uma única vez no carregamento do módulo para
// que caminhos relativos não dependam do cwd de quem iniciou o processo.
const RAIZ_PROJETO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function ancorarNaRaiz(valor: string): string {
  if (valor === ':memory:' || isAbsolute(valor)) {
    return valor;
  }
  return resolve(RAIZ_PROJETO, valor);
}

const BANCO_ABSOLUTO = ancorarNaRaiz(env.DATABASE_PATH);
const ARMAZENAMENTO_ABSOLUTO = ancorarNaRaiz(env.STORAGE_DIR);

export function caminhoBancoAbsoluto(): string {
  return BANCO_ABSOLUTO;
}

export function diretorioArmazenamentoAbsoluto(): string {
  return ARMAZENAMENTO_ABSOLUTO;
}
