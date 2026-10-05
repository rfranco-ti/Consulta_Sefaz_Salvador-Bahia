import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, ExecucoesRepository } from '../../database/index.js';
import { obterFabricaCompartilhada } from '../../modules/browser/browser.factory.js';
import { obterWorker } from '../../modules/jobs/job.worker.js';
import { InternalError } from '../../shared/errors/index.js';

export type StatusDependencia = 'ok' | 'falha';

export interface SondaBanco {
  latenciaMs: number;
}

export interface SondaFila {
  pendentes: number;
  workerVivo: boolean;
}

export interface SondaNavegador {
  quente: boolean;
  ocupados: number;
  ociosos: number;
  criados: number;
}

export interface OpcoesSaude {
  versao?: string;
  agoraMs?: () => number;
  inicioMs?: number;
  banco?: Database.Database;
  verificarBanco?: () => Promise<SondaBanco>;
  lerFila?: () => Promise<SondaFila>;
  lerNavegador?: () => Promise<SondaNavegador>;
}

export const healthRespostaSchema = z.object({
  status: z.enum(['ok']),
  versao: z.string(),
  uptimeSeg: z.number().int().nonnegative(),
});

export const prontidaoRespostaSchema = z.object({
  status: z.enum(['ok', 'falha']),
  versao: z.string(),
  uptimeSeg: z.number().int().nonnegative(),
  dependencias: z.object({
    banco: z.object({
      status: z.enum(['ok', 'falha']),
      latenciaMs: z.number().int().nonnegative().optional(),
      mensagem: z.string().optional(),
    }),
    fila: z.object({
      status: z.enum(['ok', 'falha']),
      pendentes: z.number().int().nonnegative().optional(),
      workerVivo: z.boolean().optional(),
      mensagem: z.string().optional(),
    }),
    navegador: z.object({
      status: z.enum(['ok', 'falha']),
      quente: z.boolean().optional(),
      ocupados: z.number().int().nonnegative().optional(),
      ociosos: z.number().int().nonnegative().optional(),
      criados: z.number().int().nonnegative().optional(),
      mensagem: z.string().optional(),
    }),
  }),
});

export const metricasRespostaSchema = z.object({
  versao: z.string(),
  uptimeSeg: z.number().int().nonnegative(),
  execucoes: z.object({
    porStatus: z.record(z.string(), z.number().int().nonnegative()),
    porTipoStatus: z.record(z.string(), z.record(z.string(), z.number().int().nonnegative())),
    duracaoMs: z.record(
      z.string(),
      z.object({
        p50: z.number().nonnegative(),
        p95: z.number().nonnegative(),
        amostras: z.number().int().nonnegative(),
      }),
    ),
  }),
  cache: z.object({
    hits: z.number().int().nonnegative(),
    misses: z.number().int().nonnegative(),
    entradas: z.number().int().nonnegative(),
  }),
  fila: z.object({
    pendentes: z.number().int().nonnegative(),
  }),
  navegador: z.object({
    quente: z.boolean(),
    ocupados: z.number().int().nonnegative(),
    ociosos: z.number().int().nonnegative(),
    criados: z.number().int().nonnegative(),
  }),
  processo: z.object({
    uptimeSeg: z.number().int().nonnegative(),
    rssBytes: z.number().int().nonnegative(),
  }),
});

export const erroRespostaSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export type HealthResposta = z.infer<typeof healthRespostaSchema>;
export type ErroResposta = z.infer<typeof erroRespostaSchema>;
export type ProntidaoResposta = z.infer<typeof prontidaoRespostaSchema>;
export type MetricasResposta = z.infer<typeof metricasRespostaSchema>;

const ESTADOS_EXECUCAO = ['PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED'] as const;

const healthJson = z.toJSONSchema(healthRespostaSchema, { target: 'openapi-3.0' });
const prontidaoJson = z.toJSONSchema(prontidaoRespostaSchema, { target: 'openapi-3.0' });
const metricasJson = z.toJSONSchema(metricasRespostaSchema, { target: 'openapi-3.0' });
const erroJson = z.toJSONSchema(erroRespostaSchema, { target: 'openapi-3.0' });

interface DependenciaBanco {
  status: StatusDependencia;
  latenciaMs?: number;
  mensagem?: string;
}

interface DependenciaFila {
  status: StatusDependencia;
  pendentes?: number;
  workerVivo?: boolean;
  mensagem?: string;
}

interface DependenciaNavegador {
  status: StatusDependencia;
  quente?: boolean;
  ocupados?: number;
  ociosos?: number;
  criados?: number;
  mensagem?: string;
}

interface PercentisDuracao {
  p50: number;
  p95: number;
  amostras: number;
}

export function registrarSaude(app: FastifyInstance, opcoes?: OpcoesSaude): void {
  const versao = opcoes?.versao ?? lerVersaoPacote(app);
  const inicioMs = opcoes?.inicioMs ?? Date.now();
  const agoraMs = opcoes?.agoraMs ?? Date.now;
  const bancoAtivo = (): Database.Database => opcoes?.banco ?? db();
  const verificarBanco = opcoes?.verificarBanco ?? criarVerificadorBanco(bancoAtivo);
  const lerFila = opcoes?.lerFila ?? criarLeitorFila(bancoAtivo);
  const lerNavegador = opcoes?.lerNavegador ?? lerNavegadorPadrao;
  const uptimeSeg = (): number => Math.max(0, Math.floor((agoraMs() - inicioMs) / 1000));

  app.get(
    '/health',
    {
      schema: {
        summary: 'Saude basica do processo',
        description: 'Liveness: responde 200 enquanto o processo atende requisicoes.',
        tags: ['saude'],
        response: { 200: healthJson },
      },
    },
    async (): Promise<HealthResposta> => ({ status: 'ok', versao, uptimeSeg: uptimeSeg() }),
  );

  app.get(
    '/ready',
    {
      schema: {
        summary: 'Prontidao das dependencias',
        description:
          'Readiness: banco, fila e pool de navegadores. Qualquer dependencia fora responde 503.',
        tags: ['saude'],
        response: { 200: prontidaoJson, 503: prontidaoJson },
      },
    },
    async (_request, reply): Promise<void> => {
      const dependencias = {
        banco: await sondarBanco(verificarBanco),
        fila: await sondarFila(lerFila),
        navegador: await sondarNavegador(lerNavegador),
      };
      const pronta =
        dependencias.banco.status === 'ok' &&
        dependencias.fila.status === 'ok' &&
        dependencias.navegador.status === 'ok';
      const corpo: ProntidaoResposta = {
        status: pronta ? 'ok' : 'falha',
        versao,
        uptimeSeg: uptimeSeg(),
        dependencias,
      };
      if (pronta) {
        await reply.code(200).send(corpo);
      } else {
        await reply.code(503).send(corpo);
      }
    },
  );

  app.get(
    '/metrics',
    {
      schema: {
        summary: 'Contadores operacionais',
        description:
          'Execucoes por status e tipo, duracoes p50 e p95, cache, fila, navegador e processo.',
        tags: ['saude'],
        response: { 200: metricasJson, 500: erroJson },
      },
    },
    async (request, reply): Promise<void> => {
      try {
        const [fila, navegador] = await Promise.all([lerFila(), lerNavegador()]);
        const banco = bancoAtivo();
        const corpo: MetricasResposta = {
          versao,
          uptimeSeg: uptimeSeg(),
          execucoes: {
            porStatus: contarPorStatus(banco),
            porTipoStatus: contarPorTipoStatus(banco),
            duracaoMs: resumirDuracoes(banco),
          },
          cache: { hits: 0, misses: 0, entradas: contarEntradasCache(banco) },
          fila: { pendentes: fila.pendentes },
          navegador: {
            quente: navegador.quente,
            ocupados: navegador.ocupados,
            ociosos: navegador.ociosos,
            criados: navegador.criados,
          },
          processo: { uptimeSeg: uptimeSeg(), rssBytes: process.memoryUsage().rss },
        };
        await reply.send(corpo);
      } catch (erro: unknown) {
        request.log.error({ err: erro }, 'Falha ao coletar métricas');
        const falha = new InternalError('Falha ao coletar métricas');
        const corpo: ErroResposta = { error: { code: falha.code, message: falha.message } };
        await reply.code(500).send(corpo);
      }
    },
  );
}

function criarVerificadorBanco(
  bancoAtivo: () => Database.Database,
): () => Promise<SondaBanco> {
  return async () => {
    const banco = bancoAtivo();
    const inicio = Date.now();
    banco.prepare<[], { valor: number }>('SELECT 1 AS valor').get();
    return { latenciaMs: Math.max(0, Math.round(Date.now() - inicio)) };
  };
}

function criarLeitorFila(bancoAtivo: () => Database.Database): () => Promise<SondaFila> {
  return async () => {
    const pendentes = new ExecucoesRepository(bancoAtivo()).contarPendentes();
    return { pendentes, workerVivo: obterWorker() !== null };
  };
}

async function lerNavegadorPadrao(): Promise<SondaNavegador> {
  const foto = obterFabricaCompartilhada().snapshot();
  return {
    quente: foto.total > 0,
    ocupados: foto.ocupados,
    ociosos: Math.max(0, foto.total - foto.ocupados),
    criados: foto.criados,
  };
}

async function sondarBanco(
  verificarBanco: () => Promise<SondaBanco>,
): Promise<DependenciaBanco> {
  try {
    const sonda = await verificarBanco();
    return { status: 'ok', latenciaMs: sonda.latenciaMs };
  } catch {
    return { status: 'falha', mensagem: 'Banco de dados indisponível' };
  }
}

async function sondarFila(lerFila: () => Promise<SondaFila>): Promise<DependenciaFila> {
  try {
    const sonda = await lerFila();
    if (!sonda.workerVivo) {
      return {
        status: 'falha',
        pendentes: sonda.pendentes,
        workerVivo: false,
        mensagem: 'Worker de execuções parado',
      };
    }
    return { status: 'ok', pendentes: sonda.pendentes, workerVivo: true };
  } catch {
    return { status: 'falha', mensagem: 'Fila de execuções indisponível' };
  }
}

async function sondarNavegador(
  lerNavegador: () => Promise<SondaNavegador>,
): Promise<DependenciaNavegador> {
  try {
    const sonda = await lerNavegador();
    return {
      status: 'ok',
      quente: sonda.quente,
      ocupados: sonda.ocupados,
      ociosos: sonda.ociosos,
      criados: sonda.criados,
    };
  } catch {
    return { status: 'falha', mensagem: 'Pool de navegadores indisponível' };
  }
}

function contarPorStatus(banco: Database.Database): Record<string, number> {
  const totais: Record<string, number> = {};
  for (const estado of ESTADOS_EXECUCAO) {
    totais[estado] = 0;
  }
  const linhas = banco
    .prepare<[], { status: string; total: number }>(
      'SELECT status, COUNT(*) AS total FROM execucoes GROUP BY status',
    )
    .all();
  for (const linha of linhas) {
    totais[linha.status] = linha.total;
  }
  return totais;
}

function contarPorTipoStatus(banco: Database.Database): Record<string, Record<string, number>> {
  const linhas = banco
    .prepare<[], { tipo: string; status: string; total: number }>(
      'SELECT tipo, status, COUNT(*) AS total FROM execucoes GROUP BY tipo, status',
    )
    .all();
  const saida: Record<string, Record<string, number>> = {};
  for (const linha of linhas) {
    const atual = saida[linha.tipo] ?? {};
    atual[linha.status] = linha.total;
    saida[linha.tipo] = atual;
  }
  return saida;
}

function resumirDuracoes(banco: Database.Database): Record<string, PercentisDuracao> {
  const linhas = banco
    .prepare<[], { tipo: string; duracao: number }>(
      'SELECT tipo, duracao_ms AS duracao FROM execucoes WHERE duracao_ms IS NOT NULL ORDER BY tipo ASC, duracao_ms ASC',
    )
    .all();
  const porTipo = new Map<string, number[]>();
  for (const linha of linhas) {
    const valores = porTipo.get(linha.tipo) ?? [];
    valores.push(linha.duracao);
    porTipo.set(linha.tipo, valores);
  }
  const saida: Record<string, PercentisDuracao> = {};
  for (const [tipo, valores] of porTipo) {
    const ordenados = [...valores].sort((a, b) => a - b);
    saida[tipo] = {
      p50: percentil(ordenados, 50),
      p95: percentil(ordenados, 95),
      amostras: ordenados.length,
    };
  }
  return saida;
}

function percentil(ordenados: number[], percentual: number): number {
  if (ordenados.length === 0) {
    return 0;
  }
  const indice = Math.min(
    ordenados.length - 1,
    Math.max(0, Math.ceil((percentual / 100) * ordenados.length) - 1),
  );
  return ordenados[indice] ?? 0;
}

function contarEntradasCache(banco: Database.Database): number {
  const linha = banco
    .prepare<[], { total: number }>('SELECT COUNT(*) AS total FROM cache_consultas')
    .get();
  return linha?.total ?? 0;
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
