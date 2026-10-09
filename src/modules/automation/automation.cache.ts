import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ehTipoAutomacao, type TipoAutomacao } from '../../automations/registry.js';
import { CACHE_VERSION, cacheConfig } from '../../config/cache.js';
import { CacheRepository } from '../../database/index.js';
import { ValidationError } from '../../shared/errors/index.js';
import type {
  ConsultarComCacheInput,
  ConsultarComCacheSaida,
} from './automation.types.js';

export interface CacheConsultasOpcoes {
  banco: Database.Database;
  capacidadeMemoria?: number;
  agora?: () => number;
  versaoCache?: (tipo: TipoAutomacao) => number;
}

interface EntradaMemoria {
  tipo: TipoAutomacao;
  dados: string;
  cacheVersion: number;
  expiraEmMs: number;
}

interface AcertoLeitura {
  dados: unknown;
  camada: 'memoria' | 'sqlite';
  ttlRestanteSeg: number;
}

export interface LeituraCache {
  dados: unknown;
  camada: 'memoria' | 'sqlite';
  ttlRestanteSeg: number;
}

const CAPACIDADE_MEMORIA_PADRAO = 500;
const MILIS_POR_SEGUNDO = 1000;

function ordenarValor(valor: unknown): unknown {
  if (Array.isArray(valor)) {
    return valor.map(ordenarValor);
  }
  if (valor !== null && typeof valor === 'object') {
    const ordenado: Record<string, unknown> = {};
    for (const chave of Object.keys(valor).sort()) {
      const item = (valor as Record<string, unknown>)[chave];
      if (item !== undefined) {
        ordenado[chave] = ordenarValor(item);
      }
    }
    return ordenado;
  }
  return valor;
}

export function normalizarPayload(payload: unknown): string {
  let texto: string | undefined;
  try {
    texto = JSON.stringify(ordenarValor(payload));
  } catch {
    texto = undefined;
  }
  if (texto === undefined) {
    throw new ValidationError('Parâmetros da consulta inválidos para geração da chave de cache');
  }
  return texto;
}

export function montarChaveCache(tipo: TipoAutomacao, payload: unknown): string {
  if (!ehTipoAutomacao(tipo)) {
    throw new ValidationError(`Tipo de automação inválido: ${String(tipo)}`);
  }
  return createHash('sha256').update(`${tipo}:${normalizarPayload(payload)}`).digest('hex');
}

function segundosRestantes(expiraEmMs: number, agoraMs: number): number {
  return Math.max(0, Math.ceil((expiraEmMs - agoraMs) / MILIS_POR_SEGUNDO));
}

export class CacheConsultas {
  private readonly repo: CacheRepository;
  private readonly memoria = new Map<string, EntradaMemoria>();
  private readonly voos = new Map<string, Promise<unknown>>();
  private readonly capacidade: number;
  private readonly agora: () => number;
  private readonly versaoCache: (tipo: TipoAutomacao) => number;

  constructor(opcoes: CacheConsultasOpcoes) {
    if (
      opcoes.capacidadeMemoria !== undefined &&
      (!Number.isInteger(opcoes.capacidadeMemoria) || opcoes.capacidadeMemoria <= 0)
    ) {
      throw new ValidationError('Capacidade da memória do cache deve ser um inteiro positivo');
    }
    this.repo = new CacheRepository(opcoes.banco);
    this.capacidade = opcoes.capacidadeMemoria ?? CAPACIDADE_MEMORIA_PADRAO;
    this.agora = opcoes.agora ?? (() => Date.now());
    this.versaoCache = opcoes.versaoCache ?? (() => CACHE_VERSION);
  }

  async consultarComCache<T>(input: ConsultarComCacheInput<T>): Promise<ConsultarComCacheSaida<T>> {
    if (!ehTipoAutomacao(input.tipo)) {
      throw new ValidationError(`Tipo de automação inválido: ${String(input.tipo)}`);
    }
    const versao = this.versaoCache(input.tipo);
    const chave = montarChaveCache(input.tipo, input.payload);
    const forcar = input.forceRefresh ?? cacheConfig(input.tipo).forceRefreshDefault;
    if (!forcar) {
      const acerto = this.lerCamadas(input.tipo, chave, versao);
      if (acerto !== null) {
        const resultado = acerto.dados as T;
        return {
          resultado,
          cache: { hit: true, camada: acerto.camada, ttlRestanteSeg: acerto.ttlRestanteSeg },
        };
      }
    }
    const emVoo = this.voos.get(chave);
    if (emVoo !== undefined) {
      const compartilhado = (await emVoo) as T;
      return { resultado: compartilhado, cache: { hit: false } };
    }
    const execucao: Promise<unknown> = this.executarEGravar(
      input.tipo,
      chave,
      versao,
      input.executar,
    );
    this.voos.set(chave, execucao);
    try {
      const resultado = (await execucao) as T;
      return { resultado, cache: { hit: false } };
    } finally {
      if (this.voos.get(chave) === execucao) {
        this.voos.delete(chave);
      }
    }
  }

  invalidarTipo(tipo: TipoAutomacao): number {
    let removidas = 0;
    for (const [chave, entrada] of this.memoria) {
      if (entrada.tipo === tipo) {
        this.memoria.delete(chave);
        removidas += 1;
      }
    }
    return removidas + this.repo.invalidarTipo(tipo);
  }

  limparMemoria(): void {
    this.memoria.clear();
  }

  ler(tipo: TipoAutomacao, payload: unknown): LeituraCache | null {
    if (!ehTipoAutomacao(tipo)) {
      throw new ValidationError(`Tipo de automação inválido: ${String(tipo)}`);
    }
    const versao = this.versaoCache(tipo);
    const chave = montarChaveCache(tipo, payload);
    const acerto = this.lerCamadas(tipo, chave, versao);
    if (acerto === null) {
      return null;
    }
    return { dados: acerto.dados, camada: acerto.camada, ttlRestanteSeg: acerto.ttlRestanteSeg };
  }

  gravarSucesso(
    tipo: TipoAutomacao,
    payload: unknown,
    resultado: unknown,
    expiraEm?: string,
  ): void {
    if (!ehTipoAutomacao(tipo)) {
      throw new ValidationError(`Tipo de automação inválido: ${String(tipo)}`);
    }
    let dados: string | undefined;
    try {
      dados = JSON.stringify(resultado);
    } catch {
      dados = undefined;
    }
    if (dados === undefined) {
      throw new ValidationError('Resultado da consulta inválido para armazenamento no cache');
    }
    const versao = this.versaoCache(tipo);
    const chave = montarChaveCache(tipo, payload);
    this.gravar(tipo, chave, versao, dados, expiraEm);
  }

  /**
   * Remove a entrada exata da chave nas duas camadas (memória + SQLite).
   * Evicção explícita para uso operacional/em testes. NÃO é usada pelo
   * `forceRefresh` de `obterOuCriar`: o refresh forçado preserva a entrada
   * anterior até o novo voo concluir com sucesso (`finalizar` sobrescreve
   * via INSERT OR REPLACE); se o voo falhar, a entrada antiga continua
   * válida. Invalidar no caminho do refresh causaria perda de
   * disponibilidade durante a indisponibilidade do portal.
   */
  invalidar(tipo: TipoAutomacao, payload: unknown): void {
    if (!ehTipoAutomacao(tipo)) {
      throw new ValidationError(`Tipo de automação inválido: ${String(tipo)}`);
    }
    const chave = montarChaveCache(tipo, payload);
    this.memoria.delete(chave);
    this.repo.remover(chave);
  }

  tamanhoMemoria(): number {
    return this.memoria.size;
  }

  private async executarEGravar<T>(
    tipo: TipoAutomacao,
    chave: string,
    versao: number,
    executar: () => Promise<T>,
  ): Promise<T> {
    const resultado = await executar();
    let dados: string | undefined;
    try {
      dados = JSON.stringify(resultado);
    } catch {
      dados = undefined;
    }
    if (dados === undefined) {
      throw new ValidationError('Resultado da consulta inválido para armazenamento no cache');
    }
    this.gravar(tipo, chave, versao, dados);
    return resultado;
  }

  private gravar(
    tipo: TipoAutomacao,
    chave: string,
    versao: number,
    dados: string,
    expiraEm?: string,
  ): void {
    const ttlMs = cacheConfig(tipo).ttlMs;
    this.repo.invalidarVersoesAnteriores(tipo, versao);
    this.repo.salvar({
      chave,
      tipo,
      dados,
      cacheVersion: versao,
      ttlMs,
      ...(expiraEm === undefined ? {} : { expiraEm }),
    });
    this.memoria.set(chave, {
      tipo,
      dados,
      cacheVersion: versao,
      expiraEmMs: expiraEm === undefined ? this.agora() + ttlMs : Date.parse(expiraEm),
    });
    this.aplicarTeto();
  }

  private lerCamadas(tipo: TipoAutomacao, chave: string, versao: number): AcertoLeitura | null {
    const agoraMs = this.agora();
    const entradaMemoria = this.memoria.get(chave);
    if (entradaMemoria !== undefined) {
      if (entradaMemoria.expiraEmMs <= agoraMs || entradaMemoria.cacheVersion !== versao) {
        this.memoria.delete(chave);
        if (entradaMemoria.cacheVersion !== versao) {
          this.repo.invalidarVersoesAnteriores(tipo, versao);
        }
        return this.lerSqlite(tipo, chave, versao, agoraMs);
      }
      this.memoria.delete(chave);
      this.memoria.set(chave, entradaMemoria);
      const dados: unknown = JSON.parse(entradaMemoria.dados);
      return {
        dados,
        camada: 'memoria',
        ttlRestanteSeg: segundosRestantes(entradaMemoria.expiraEmMs, agoraMs),
      };
    }
    return this.lerSqlite(tipo, chave, versao, agoraMs);
  }

  private lerSqlite(
    tipo: TipoAutomacao,
    chave: string,
    versao: number,
    agoraMs: number,
  ): AcertoLeitura | null {
    const entrada = this.repo.obter(chave, new Date(agoraMs).toISOString());
    if (entrada === null) {
      return null;
    }
    if (entrada.cacheVersion !== versao) {
      this.repo.invalidarVersoesAnteriores(tipo, versao);
      return null;
    }
    const expiraEmMs = Date.parse(entrada.expiraEm);
    this.memoria.set(chave, {
      tipo,
      dados: entrada.dados,
      cacheVersion: entrada.cacheVersion,
      expiraEmMs,
    });
    this.aplicarTeto();
    const dados: unknown = JSON.parse(entrada.dados);
    return {
      dados,
      camada: 'sqlite',
      ttlRestanteSeg: segundosRestantes(expiraEmMs, agoraMs),
    };
  }

  private aplicarTeto(): void {
    while (this.memoria.size > this.capacidade) {
      const maisAntiga = this.memoria.keys().next();
      if (maisAntiga.done) {
        return;
      }
      this.memoria.delete(maisAntiga.value);
    }
  }
}
