try {
  process.loadEnvFile();
} catch {
}

import type { FastifyInstance } from 'fastify';
import type { TipoAutomacao } from '../src/automations/registry.js';
import type { ExecucaoResposta } from '../src/modules/automation/automation.types.js';
import type { ItemPlano, LinhaRelatorio } from './smoke-nucleo.js';

interface SaidaChamada {
  resposta: ExecucaoResposta | null;
  falha: string | null;
}

function mensagemDeErro(erro: unknown): string {
  if (erro instanceof Error) {
    return erro.message;
  }
  return String(erro);
}

function extrairMensagemErro(corpo: unknown, status: number): string {
  if (typeof corpo === 'object' && corpo !== null && !Array.isArray(corpo)) {
    const registro = corpo as Record<string, unknown>;
    const erro = registro['error'];
    if (typeof erro === 'object' && erro !== null && !Array.isArray(erro)) {
      const detalhe = erro as Record<string, unknown>;
      const codigo = detalhe['code'];
      const mensagem = detalhe['message'];
      if (typeof codigo === 'string' && typeof mensagem === 'string') {
        return codigo + ': ' + mensagem;
      }
      if (typeof mensagem === 'string') {
        return mensagem;
      }
    }
    const direta = registro['message'];
    if (typeof direta === 'string') {
      return direta;
    }
  }
  return 'http ' + String(status);
}

function dormir(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function baseLocal(porta: number): string {
  return 'http:' + '/'.repeat(2) + '127.0.0.1:' + String(porta);
}

async function criarChaveApi(base: string, adminKey: string | undefined): Promise<string> {
  if (adminKey === undefined || adminKey === '') {
    throw new Error('ADMIN_KEY ausente: defina no .env para rodar o smoke');
  }
  const resposta = await fetch(base + '/v1/admin/apikeys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
    body: JSON.stringify({ nome: 'smoke-e2e' }),
    signal: AbortSignal.timeout(30000),
  });
  const corpo: unknown = await resposta.json();
  if (!resposta.ok) {
    throw new Error('falha ao criar api key: ' + extrairMensagemErro(corpo, resposta.status));
  }
  if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo)) {
    throw new Error('resposta inesperada ao criar api key');
  }
  const token: unknown = (corpo as Record<string, unknown>)['apiKey'];
  if (typeof token !== 'string' || token === '') {
    throw new Error('resposta inesperada ao criar api key');
  }
  return token;
}

async function postAutomacao(
  base: string,
  chaveApi: string,
  tipo: TipoAutomacao,
  payload: Record<string, unknown>,
  normalizar: (corpo: unknown) => ExecucaoResposta | null,
): Promise<SaidaChamada> {
  let resposta: Response;
  try {
    resposta = await fetch(base + '/v1/automacoes/' + tipo, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': chaveApi },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
  } catch (erro) {
    return { resposta: null, falha: 'falha de rede no POST: ' + mensagemDeErro(erro) };
  }
  let corpo: unknown = null;
  try {
    corpo = await resposta.json();
  } catch {
    corpo = null;
  }
  if (!resposta.ok) {
    return { resposta: null, falha: extrairMensagemErro(corpo, resposta.status) };
  }
  const execucao = normalizar(corpo);
  if (execucao === null) {
    return { resposta: null, falha: 'resposta inesperada do servidor no POST' };
  }
  return { resposta: execucao, falha: null };
}

async function getExecucao(
  base: string,
  chaveApi: string,
  execucaoId: string,
  normalizar: (corpo: unknown) => ExecucaoResposta | null,
): Promise<SaidaChamada> {
  let resposta: Response;
  try {
    resposta = await fetch(base + '/v1/execucoes/' + execucaoId, {
      headers: { 'x-api-key': chaveApi },
      signal: AbortSignal.timeout(30000),
    });
  } catch (erro) {
    return { resposta: null, falha: 'falha de rede no polling: ' + mensagemDeErro(erro) };
  }
  let corpo: unknown = null;
  try {
    corpo = await resposta.json();
  } catch {
    corpo = null;
  }
  if (!resposta.ok) {
    return { resposta: null, falha: extrairMensagemErro(corpo, resposta.status) };
  }
  const execucao = normalizar(corpo);
  if (execucao === null) {
    return { resposta: null, falha: 'resposta inesperada do servidor no polling' };
  }
  return { resposta: execucao, falha: null };
}

async function executarRobot(
  base: string,
  chaveApi: string,
  tipo: TipoAutomacao,
  payload: Record<string, unknown>,
  nucleo: typeof import('./smoke-nucleo.js'),
): Promise<LinhaRelatorio> {
  const inicio = Date.now();
  const criado = await postAutomacao(base, chaveApi, tipo, payload, nucleo.normalizarExecucao);
  if (criado.falha !== null || criado.resposta === null) {
    return {
      tipo,
      resultado: 'FAIL',
      duracaoMs: Date.now() - inicio,
      observacao: criado.falha ?? 'resposta vazia do servidor',
    };
  }
  let atual: ExecucaoResposta = criado.resposta;
  while (nucleo.deveContinuarPoll(atual.status)) {
    if (nucleo.estourouOrcamento(inicio, Date.now())) {
      return nucleo.linhaDeTimeout(tipo, Date.now() - inicio);
    }
    await dormir(nucleo.INTERVALO_POLL_MS);
    const consulta = await getExecucao(base, chaveApi, atual.execucaoId, nucleo.normalizarExecucao);
    if (consulta.falha !== null || consulta.resposta === null) {
      return {
        tipo,
        resultado: 'FAIL',
        duracaoMs: Date.now() - inicio,
        observacao: consulta.falha ?? 'resposta vazia do servidor',
      };
    }
    atual = consulta.resposta;
  }
  const erro = atual.error?.message ?? atual.error?.code ?? null;
  const sucesso = atual.resultado?.sucesso ?? null;
  const mensagem = atual.resultado?.mensagem ?? null;
  const duracao = atual.duracaoMs ?? Date.now() - inicio;
  return nucleo.linhaDoDesfecho({
    tipo,
    status: atual.status,
    sucesso,
    duracaoMs: duracao,
    erro: erro ?? mensagem,
    cacheHit: atual.cache?.hit ?? false,
  });
}

async function principal(): Promise<number> {
  const nucleo = await import('./smoke-nucleo.js');
  const parseado = nucleo.parsearApenas(process.argv.slice(2));
  if (parseado.erro !== null) {
    process.stderr.write('smoke: ' + parseado.erro + '\n');
    return 1;
  }
  const { registrarExtratorTextoPdf } = await import('../src/automations/base/ocr.js');
  const { cadeiaExtracaoTextoPdf } = await import(
    '../src/automations/base/ocr/extracao-pdf.js'
  );
  const { registrarResolvedorCaptcha } = await import('../src/automations/base/captcha.js');
  const { resolverCaptchaLocal, encerrarWorkerCaptcha } = await import(
    '../src/automations/base/captcha/resolvedor.js'
  );
  const { buildApp } = await import('../src/app/app.js');
  const { iniciarWorker, pararWorker } = await import('../src/modules/jobs/index.js');
  const { db, fecharDb } = await import('../src/database/index.js');
  const { encerrarBrowserService } = await import(
    '../src/modules/browser/browser.service.js'
  );
  const { env } = await import('../src/config/env.js');
  registrarExtratorTextoPdf(cadeiaExtracaoTextoPdf);
  registrarResolvedorCaptcha(resolverCaptchaLocal);
  const app: FastifyInstance = await buildApp();
  await iniciarWorker({ banco: db(), filaTimeoutSeg: env.FILA_TIMEOUT_SEG });
  try {
    await app.listen({ port: 0 });
    const endereco = app.server.address();
    const porta = typeof endereco === 'object' && endereco !== null ? endereco.port : 0;
    const base = baseLocal(porta);
    const chaveApi = await criarChaveApi(base, env.ADMIN_KEY);
    const linhas: LinhaRelatorio[] = [];
    const plano: ItemPlano[] = nucleo.filtrarPlano(
      nucleo.lerPlanoSmoke(process.env),
      parseado.tipos,
    );
    for (const item of plano) {
      if (item.acao === 'pular') {
        linhas.push(nucleo.linhaDeSkip(item.tipo, 'sem ' + item.variavel));
        continue;
      }
      if (item.acao === 'invalido' || item.payload === null) {
        linhas.push(nucleo.linhaDeEntradaInvalida(item));
        continue;
      }
      linhas.push(await executarRobot(base, chaveApi, item.tipo, item.payload, nucleo));
    }
    const relatorio = nucleo.montarRelatorio(linhas);
    await nucleo.drenarStdout(relatorio.texto);
    return relatorio.exitCode;
  } finally {
    await encerrarWorkerCaptcha();
    await pararWorker();
    await app.close();
    await encerrarBrowserService();
    fecharDb();
  }
}

let codigo = 1;
try {
  codigo = await principal();
} catch (erro: unknown) {
  await new Promise<void>((resolver) => {
    process.stderr.write('smoke falhou: ' + mensagemDeErro(erro) + '\n', () => resolver());
  });
  codigo = 1;
}
process.exit(codigo);
