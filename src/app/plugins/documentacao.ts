import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TIPOS_AUTOMACAO } from '../../automations/registry.js';
import {
  artefatosSchema,
  paramsPorTipo,
  tipoParamSchema,
} from '../../modules/automation/automation.schemas.js';

export interface OpcoesDocumentacao {
  versao?: string;
  titulo?: string;
  descricao?: string;
}

type EsquemaJson = { [chave: string]: unknown };

const TITULO_PADRAO = 'api-sefaz-ssa';

const DESCRICAO_PADRAO =
  'API de automação de consultas nos portais SEFAZ Bahia e SEFAZ Salvador. ' +
  'Rotas sob /v1 exigem API key no header X-API-Key ou na query ?apikey=. ' +
  'Rotas de saúde (/health, /ready, /metrics) e esta documentação (/docs) são públicas.';

export async function registrarDocumentacao(
  app: FastifyInstance,
  opcoes?: OpcoesDocumentacao,
): Promise<void> {
  const versao = opcoes?.versao ?? lerVersaoPacote(app);
  const titulo = opcoes?.titulo ?? TITULO_PADRAO;
  const descricao = opcoes?.descricao ?? DESCRICAO_PADRAO;
  await app.register(swagger, {
    openapi: {
      info: { title: titulo, version: versao, description: descricao },
      tags: [
        {
          name: 'saude',
          description: 'Liveness, readiness e contadores operacionais.',
        },
        {
          name: 'automacoes',
          description: 'Criação e acompanhamento de execuções das automações.',
        },
      ],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    transformSpecification: (documento) => ({
      ...documento,
      components: combinarComponentes(documento.components),
    }),
  });
}

function esquemasAutomacao(): Record<string, EsquemaJson> {
  const esquemas: Record<string, EsquemaJson> = {
    Artefatos: paraEsquema(z.toJSONSchema(artefatosSchema, { target: 'openapi-3.0' })),
    TipoAutomacao: paraEsquema(z.toJSONSchema(tipoParamSchema, { target: 'openapi-3.0' })),
  };
  for (const tipo of TIPOS_AUTOMACAO) {
    esquemas[`${tipo}-params`] = paraEsquema(
      z.toJSONSchema(paramsPorTipo[tipo], { target: 'openapi-3.0', io: 'input' }),
    );
  }
  return esquemas;
}

function paraEsquema(esquema: { [chave: string]: unknown }): EsquemaJson {
  return { ...esquema };
}

function combinarComponentes(valor: unknown): Record<string, unknown> {
  const atual = paraRegistro(valor);
  const esquemas = paraRegistro(atual['schemas']);
  return { ...atual, schemas: { ...esquemas, ...esquemasAutomacao() } };
}

function paraRegistro(valor: unknown): Record<string, unknown> {
  if (typeof valor === 'object' && valor !== null && !Array.isArray(valor)) {
    return valor as Record<string, unknown>;
  }
  return {};
}

function lerVersaoPacote(app: FastifyInstance): string {
  try {
    const diretorio = dirname(fileURLToPath(import.meta.url));
    const bruto = readFileSync(join(diretorio, '..', '..', '..', 'package.json'), 'utf8');
    const versao = extrairVersao(JSON.parse(bruto) as unknown);
    if (versao !== null) {
      return versao;
    }
  } catch (erro: unknown) {
    app.log.warn({ err: erro }, 'Não foi possível ler a versão do package.json');
  }
  return '0.0.0';
}

function extrairVersao(pacote: unknown): string | null {
  if (typeof pacote !== 'object' || pacote === null || Array.isArray(pacote)) {
    return null;
  }
  const versao: unknown = (pacote as Record<string, unknown>)['version'];
  return typeof versao === 'string' && versao.length > 0 ? versao : null;
}
