import { describe, expect, it } from 'vitest';
import '../../src/automations/index.js';
import { TIPOS_AUTOMACAO } from '../../src/automations/registry.js';
import {
  damTffTllInputSchema,
  paramsPorTipo,
  schemaDoTipo,
} from '../../src/modules/automation/automation.schemas.js';
import { ValidationError } from '../../src/shared/errors/index.js';

const AMOSTRAS: Record<(typeof TIPOS_AUTOMACAO)[number], Record<string, unknown>> = {
  'sefaz-bahia': { cnpj: '12.345.678/0001-90' },
  'sefaz-bahia-inscricao': { inscricaoEstadual: '123456789' },
  'sefaz-bahia-socio': { cpf: '123.456.789-09' },
  'consulta-inscricoes': { cnpj: '12345678000190' },
  'iptu-salvador': { numeroIptu: '12345' },
  'ficha-cadastral': { cnpj: '12345678000190' },
  'alvara-funcionamento': { cnpj: '12345678000190', inscricaoMunicipal: '123456' },
  'cadin-salvador': { cnpj: '12345678000190' },
  'dam-tff-tll': { cga: '123456', exercicio: 2026 },
};

describe('paramsPorTipo', () => {
  it('registra schema para os nove tipos sem lançar Fase 4', () => {
    expect(Object.keys(paramsPorTipo).sort()).toEqual([...TIPOS_AUTOMACAO].sort());
    for (const tipo of TIPOS_AUTOMACAO) {
      expect(() => schemaDoTipo(tipo)).not.toThrow();
    }
  });

  it('valida e normaliza a amostra de cada tipo', () => {
    for (const tipo of TIPOS_AUTOMACAO) {
      const schema = schemaDoTipo(tipo);
      const saida = schema.safeParse(AMOSTRAS[tipo]);
      expect(saida.success, `amostra inválida para ${tipo}`).toBe(true);
    }
  });

  it('rejeita amostra inválida de cada tipo', () => {
    for (const tipo of TIPOS_AUTOMACAO) {
      const schema = schemaDoTipo(tipo);
      expect(schema.safeParse({}).success, `vazio aceito para ${tipo}`).toBe(false);
    }
  });

  it('rejeita tipo desconhecido com erro de validação em português', () => {
    const falha = (() => {
      try {
        schemaDoTipo('portal-fantasma');
        return null;
      } catch (erro: unknown) {
        return erro;
      }
    })();
    expect(falha).toBeInstanceOf(ValidationError);
  });
});

describe('damTffTllInputSchema', () => {
  it('aceita inscrição municipal com exercício numérico', () => {
    const saida = damTffTllInputSchema.safeParse({ inscricaoMunicipal: '123456', exercicio: 2026 });
    expect(saida.success).toBe(true);
    if (saida.success) {
      expect(saida.data).toEqual({ inscricaoMunicipal: '123456', exercicio: '2026' });
    }
  });

  it('aceita o apelido cga com exercício textual', () => {
    const saida = damTffTllInputSchema.safeParse({ cga: '654321', exercicio: '2026' });
    expect(saida.success).toBe(true);
  });

  it('rejeita inscrição curta e exercício fora do ano', () => {
    expect(damTffTllInputSchema.safeParse({ cga: '123', exercicio: '2026' }).success).toBe(false);
    expect(damTffTllInputSchema.safeParse({ cga: '123456', exercicio: '26' }).success).toBe(false);
  });
});
