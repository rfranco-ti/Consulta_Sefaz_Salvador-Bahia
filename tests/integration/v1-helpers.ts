import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { configurarErros } from '../../src/app/erros.js';
import { registrarAutenticacao } from '../../src/app/plugins/auth.js';
import { registrarConsultas } from '../../src/app/routes/consultas.js';
import { registrarDocumentos } from '../../src/app/routes/documentos.js';
import { registrarExecucoes, registrarProgresso, type ServicoExecucoes } from '../../src/app/routes/execucoes.js';
import { ApiKeysRepository } from '../../src/database/repositories/api-keys.repository.js';
import { DocumentosRepository } from '../../src/database/repositories/documentos.repository.js';
import { AutomationService } from '../../src/modules/automation/automation.service.js';
import { CanalProgresso } from '../../src/modules/jobs/progresso.js';
import { criarBancoTemporario, criarChaveApi, type BancoTemporario } from './database-helpers.js';

export interface MundoV1 {
  app: FastifyInstance;
  servico: AutomationService;
  canal: CanalProgresso;
  tmp: BancoTemporario;
  armazenamento: string;
  tokenA: string;
  tokenB: string;
  chaveA: string;
  chaveB: string;
}

export interface OpcoesMundoV1 {
  servico?: ServicoExecucoes;
}

export function sha256(valor: string): string {
  return createHash('sha256').update(valor, 'utf8').digest('hex');
}

export function esperar(ms: number): Promise<void> {
  return new Promise((resolver) => setTimeout(resolver, ms));
}

export async function criarMundoV1(opcoes: OpcoesMundoV1 = {}): Promise<MundoV1> {
  const tmp = criarBancoTemporario();
  const tokenA = randomBytes(32).toString('base64url');
  const tokenB = randomBytes(32).toString('base64url');
  const chaveA = criarChaveApi(tmp.banco, { keyHash: sha256(tokenA) }).id;
  const chaveB = criarChaveApi(tmp.banco, { keyHash: sha256(tokenB) }).id;
  const repositorio = new ApiKeysRepository(tmp.banco);
  const armazenamento = mkdtempSync(join(tmpdir(), 'storage-v1-teste-'));
  const canal = new CanalProgresso();
  const servico = new AutomationService({
    banco: tmp.banco,
    canal,
    diretorioArmazenamento: armazenamento,
  });
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 });
  registrarAutenticacao(app, { repositorio });
  configurarErros(app);
  const roteamento: ServicoExecucoes = opcoes.servico ?? servico;
  const documentos = new DocumentosRepository(tmp.banco);
  registrarExecucoes(app, { servico: roteamento, documentos, diretorioArmazenamento: armazenamento });
  registrarConsultas(app, { servico: roteamento, documentos, diretorioArmazenamento: armazenamento });
  registrarDocumentos(app, { servico: roteamento, documentos, diretorioArmazenamento: armazenamento });
  registrarProgresso(app, { servico: roteamento, canal });
  return { app, servico, canal, tmp, armazenamento, tokenA, tokenB, chaveA, chaveB };
}

export async function fecharMundoV1(mundo: MundoV1): Promise<void> {
  await mundo.app.close();
  mundo.tmp.limpar();
  rmSync(mundo.armazenamento, { recursive: true, force: true });
}
