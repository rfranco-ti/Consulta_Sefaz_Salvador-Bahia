import { z } from 'zod';
import { TIPOS_AUTOMACAO } from '../../automations/registry.js';

export const artefatosSchema = z.enum(['nenhum', 'pdf', 'print', 'ambos']);

export const execucaoComumSchema = z.object({
  artefatos: artefatosSchema.default('nenhum'),
  inline: z.boolean().default(false),
  forceRefresh: z.boolean().optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

export const tipoParamSchema = z.enum(TIPOS_AUTOMACAO);

export type ExecucaoComum = z.infer<typeof execucaoComumSchema>;

export const paramsPorTipo: Partial<
  Record<(typeof TIPOS_AUTOMACAO)[number], z.ZodType>
> = {};

export function schemaDoTipo(tipo: (typeof TIPOS_AUTOMACAO)[number]): z.ZodType {
  const s = paramsPorTipo[tipo];
  if (!s) {
    throw new Error(`Schema de params nao registrado para "${tipo}" (Fase 4)`);
  }
  return s;
}
