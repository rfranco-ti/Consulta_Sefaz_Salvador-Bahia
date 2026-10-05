import { z } from 'zod';
import { ehTipoAutomacao, TIPOS_AUTOMACAO, type TipoAutomacao } from '../../automations/registry.js';
import { alvaraFuncionamentoInputSchema } from '../../automations/sites/alvara-funcionamento/alvara-funcionamento.robot.js';
import { cadinSalvadorInputSchema } from '../../automations/sites/cadin-salvador/cadin-salvador.robot.js';
import { consultaInscricoesInputSchema } from '../../automations/sites/consulta-inscricoes/consulta-inscricoes.robot.js';
import { fichaCadastralInputSchema } from '../../automations/sites/ficha-cadastral/ficha-cadastral.robot.js';
import { iptuSalvadorInputSchema } from '../../automations/sites/iptu-salvador/iptu-salvador.robot.js';
import { sefazBahiaInscricaoInputSchema } from '../../automations/sites/sefaz-bahia-inscricao/sefaz-bahia-inscricao.robot.js';
import { sefazBahiaSocioInputSchema } from '../../automations/sites/sefaz-bahia-socio/sefaz-bahia-socio.robot.js';
import { sefazBahiaInputSchema } from '../../automations/sites/sefaz-bahia/sefaz-bahia.robot.js';
import { ValidationError } from '../../shared/errors/index.js';

export const artefatosSchema = z.enum(['nenhum', 'pdf', 'print', 'ambos']);

export const execucaoComumSchema = z.object({
  artefatos: artefatosSchema.default('nenhum'),
  inline: z.boolean().default(false),
  forceRefresh: z.boolean().optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

export const tipoParamSchema = z.enum(TIPOS_AUTOMACAO);

export type ExecucaoComum = z.infer<typeof execucaoComumSchema>;

const damBaseSchema = z.object({
  inscricaoMunicipal: z.string().optional(),
  cga: z.string().optional(),
  exercicio: z.union([z.string(), z.number()]).optional(),
});

function damParaCanonico(valor: z.infer<typeof damBaseSchema>): {
  inscricaoMunicipal: string;
  exercicio: string;
} {
  return {
    inscricaoMunicipal: (valor.inscricaoMunicipal ?? valor.cga ?? '').replace(/\D/g, ''),
    exercicio: String(valor.exercicio ?? '').replace(/\D/g, ''),
  };
}

export const damTffTllInputSchema = damBaseSchema
  .transform((valor) => damParaCanonico(valor))
  .refine(
    (valor) => valor.inscricaoMunicipal.length >= 6 && valor.inscricaoMunicipal.length <= 15,
    'Inscrição municipal (CGA) inválida: informe de 6 a 15 dígitos',
  )
  .refine((valor) => /^\d{4}$/.test(valor.exercicio), 'Exercício inválido: informe o ano com 4 dígitos');

export const paramsPorTipo: Record<TipoAutomacao, z.ZodType> = {
  'sefaz-bahia': sefazBahiaInputSchema,
  'sefaz-bahia-inscricao': sefazBahiaInscricaoInputSchema,
  'sefaz-bahia-socio': sefazBahiaSocioInputSchema,
  'consulta-inscricoes': consultaInscricoesInputSchema,
  'iptu-salvador': iptuSalvadorInputSchema,
  'ficha-cadastral': fichaCadastralInputSchema,
  'alvara-funcionamento': alvaraFuncionamentoInputSchema,
  'cadin-salvador': cadinSalvadorInputSchema,
  'dam-tff-tll': damTffTllInputSchema,
};

export function schemaDoTipo(tipo: string): z.ZodType {
  if (!ehTipoAutomacao(tipo)) {
    throw new ValidationError(`Tipo de automação inválido: ${tipo}`);
  }
  return paramsPorTipo[tipo];
}
