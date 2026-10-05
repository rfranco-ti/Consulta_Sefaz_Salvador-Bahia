import { z } from 'zod';
import { TIPOS_AUTOMACAO } from '../../automations/registry.js';

/**
 * Schemas de entrada (Zod). Um schema por rota; validado no controller.
 * TODO(Fase 4): cada robot contribui com seu proprio schema de params
 * (cnpj, inscricaoMunicipal, exercicio...) e o registry o referencia.
 */

export const artefatosSchema = z.enum(['nenhum', 'pdf', 'print', 'ambos']);

/** Campos comuns a toda execucao (API.md). */
export const execucaoComumSchema = z.object({
  artefatos: artefatosSchema.default('nenhum'),
  inline: z.boolean().default(false),
  forceRefresh: z.boolean().optional(),
  /** Chave de idempotencia: retry do cliente devolve a MESMA execucao. */
  idempotencyKey: z.string().min(8).max(128).optional(),
});

export const tipoParamSchema = z.enum(TIPOS_AUTOMACAO);

export type ExecucaoComum = z.infer<typeof execucaoComumSchema>;

/** Params de cada automacao — preenchido na Fase 4. */
export const paramsPorTipo: Partial<
  Record<(typeof TIPOS_AUTOMACAO)[number], z.ZodType>
> = {
  // 'sefaz-bahia': z.object({ cnpj: cnpjSchema }),
  // ...
};

/** Resolve o schema de params para o tipo, com erro claro se ainda nao existe. */
export function schemaDoTipo(tipo: (typeof TIPOS_AUTOMACAO)[number]): z.ZodType {
  const s = paramsPorTipo[tipo];
  if (!s) {
    throw new Error(`Schema de params nao registrado para "${tipo}" (Fase 4)`);
  }
  return s;
}
