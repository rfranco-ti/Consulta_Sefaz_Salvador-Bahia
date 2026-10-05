import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db, DocumentosRepository } from '../../database/index.js';
import type { ExecucaoResposta } from '../../modules/automation/automation.types.js';
import { NotFoundError } from '../../shared/errors/index.js';
import { exigirApiKey, responderComErro } from '../erros.js';

export type LeitorArquivo = (caminho: string) => Promise<Buffer>;

export interface ServicoDocumentos {
  consultar(id: string, apiKeyId: string): Promise<ExecucaoResposta>;
}

export interface DepsDocumentos {
  documentos?: DocumentosRepository;
  diretorioArmazenamento?: string;
  lerArquivo?: LeitorArquivo;
  servico?: ServicoDocumentos;
}

const idParamsSchema = z.object({
  id: z
    .string({ error: 'Identificador é obrigatório' })
    .trim()
    .min(1, { error: 'Identificador é obrigatório' }),
});

export async function lerDoArmazenamento(diretorio: string, caminho: string): Promise<Buffer> {
  const base = resolve(diretorio);
  const alvo = resolve(base, caminho);
  if (alvo !== base && !alvo.startsWith(base + sep)) {
    throw new NotFoundError('Documento não encontrado');
  }
  try {
    return await readFile(alvo);
  } catch (erro) {
    if (erro instanceof Error && (erro as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new NotFoundError('Arquivo do documento não encontrado');
    }
    throw erro;
  }
}

export function registrarDocumentos(app: FastifyInstance, deps: DepsDocumentos = {}): void {
  app.get('/v1/documentos/:id', async (request, reply) => {
    try {
      exigirApiKey(request);
      const { id } = idParamsSchema.parse(request.params);
      const repositorio = deps.documentos ?? new DocumentosRepository(db());
      const documento = repositorio.buscarPorId(id);
      if (documento === null) {
        throw new NotFoundError('Documento não encontrado');
      }
      if (documento.apiKeyId !== request.apiKeyId) {
        await exigirAcessoParticipante(deps.servico, documento.execucaoId, request.apiKeyId);
      }
      const ler =
        deps.lerArquivo ??
        ((caminho: string) =>
          lerDoArmazenamento(deps.diretorioArmazenamento ?? env.STORAGE_DIR, caminho));
      const bytes = await ler(documento.caminho);
      await reply
        .header('content-type', documento.contentType)
        .header('content-disposition', `attachment; filename="${documento.nomeArquivo}"`)
        .send(bytes);
    } catch (erro) {
      await responderComErro(reply, erro);
    }
  });
}

async function exigirAcessoParticipante(
  servico: ServicoDocumentos | undefined,
  execucaoId: string,
  apiKeyId: string,
): Promise<void> {
  if (servico === undefined) {
    throw new NotFoundError('Documento não encontrado');
  }
  try {
    await servico.consultar(execucaoId, apiKeyId);
  } catch {
    throw new NotFoundError('Documento não encontrado');
  }
}
