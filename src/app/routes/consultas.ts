import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ehTipoAutomacao } from '../../automations/registry.js';
import { artefatosSchema, schemaDoTipo } from '../../modules/automation/automation.schemas.js';
import type {
  ConsultarSincronaInput,
  ExecucaoResposta,
} from '../../modules/automation/automation.types.js';
import { ValidationError } from '../../shared/errors/index.js';
import { exigirApiKey, responderComErro } from '../erros.js';
import type { LeitorArquivo } from './documentos.js';
import { esperaDaQuery, responderExecucao } from './execucoes.js';
import type { DocumentosRepository } from '../../database/index.js';

export interface ServicoConsultas {
  consultarSincrona(input: ConsultarSincronaInput): Promise<ExecucaoResposta>;
}

export interface DepsConsultas {
  servico: ServicoConsultas;
  documentos?: DocumentosRepository;
  diretorioArmazenamento?: string;
  lerArquivo?: LeitorArquivo;
}

const ESPERA_PADRAO_SEG = 30;

const CHAVES_CONTROLE = new Set([
  'apikey',
  'wait',
  'artefatos',
  'forceRefresh',
  'inline',
  'async',
  'idempotencyKey',
]);

const tipoParamsSchema = z.object({
  tipo: z.string({ error: 'Tipo de automação é obrigatório' }).trim().min(1, {
    error: 'Tipo de automação é obrigatório',
  }),
});

function consultaComoRegistro(query: unknown): Record<string, unknown> {
  if (typeof query !== 'object' || query === null) {
    return {};
  }
  return query as Record<string, unknown>;
}

function artefatosDaQuery(valor: unknown): 'nenhum' | 'pdf' | 'print' | 'ambos' {
  if (valor === undefined) {
    return 'nenhum';
  }
  const saida = artefatosSchema.safeParse(valor);
  if (!saida.success) {
    throw new ValidationError('Opção de artefatos inválida: use nenhum, pdf, print ou ambos');
  }
  return saida.data;
}

function boolDaQuery(valor: unknown, campo: string): boolean {
  if (valor === undefined) {
    return false;
  }
  if (typeof valor === 'boolean') {
    return valor;
  }
  if (typeof valor === 'string') {
    const normalizado = valor.trim().toLowerCase();
    if (normalizado === 'true' || normalizado === '1') {
      return true;
    }
    if (normalizado === 'false' || normalizado === '0') {
      return false;
    }
  }
  throw new ValidationError(`Parâmetro inválido: ${campo} deve ser verdadeiro ou falso`);
}

export function registrarConsultas(app: FastifyInstance, deps: DepsConsultas): void {
  const servico = deps.servico;

  app.get('/v1/consultas/:tipo', async (request, reply) => {
    try {
      exigirApiKey(request);
      const { tipo } = tipoParamsSchema.parse(request.params);
      if (!ehTipoAutomacao(tipo)) {
        throw new ValidationError(`Tipo de automação inválido: ${tipo}`);
      }
      schemaDoTipo(tipo);
      const query = consultaComoRegistro(request.query);
      const params: Record<string, unknown> = {};
      for (const [chave, valor] of Object.entries(query)) {
        if (!CHAVES_CONTROLE.has(chave)) {
          params[chave] = valor;
        }
      }
      const espera = esperaDaQuery(query['wait']) ?? ESPERA_PADRAO_SEG;
      const entrada: ConsultarSincronaInput = {
        tipo,
        params,
        artefatos: artefatosDaQuery(query['artefatos']),
        inline: boolDaQuery(query['inline'], 'inline'),
        forceRefresh: boolDaQuery(query['forceRefresh'], 'forceRefresh'),
        apiKeyId: request.apiKeyId,
        waitSeg: espera,
      };
      const resposta = await servico.consultarSincrona(entrada);
      if (resposta.status === 'PENDING' || resposta.status === 'RUNNING') {
        await reply.code(504).send({
          error: {
            code: 'TIMEOUT',
            message: 'Tempo de espera esgotado; a execução segue em andamento',
            details: { execucaoId: resposta.execucaoId, status: resposta.status },
          },
        });
        return;
      }
      await responderExecucao(reply, resposta, {
        inline: entrada.inline,
        documentos: deps.documentos,
        diretorioArmazenamento: deps.diretorioArmazenamento,
        lerArquivo: deps.lerArquivo,
      });
    } catch (erro) {
      await responderComErro(reply, erro);
    }
  });
}
