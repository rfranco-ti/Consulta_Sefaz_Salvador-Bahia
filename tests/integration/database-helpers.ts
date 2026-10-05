import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/database/client.js';
import { aplicarMigrations } from '../../src/database/migrations/index.js';

export interface BancoTemporario {
  banco: Database.Database;
  diretorio: string;
  arquivo: string;
  limpar: () => void;
}

export function criarBancoTemporario(): BancoTemporario {
  const diretorio = mkdtempSync(join(tmpdir(), 'api-sefaz-teste-'));
  const arquivo = join(diretorio, 'teste.sqlite');
  const banco = openDatabase(arquivo);
  aplicarMigrations(banco);
  return {
    banco,
    diretorio,
    arquivo,
    limpar: () => {
      banco.close();
      rmSync(diretorio, { recursive: true, force: true });
    },
  };
}

export function criarChaveApi(
  banco: Database.Database,
  parcial?: { id?: string; nome?: string; keyHash?: string },
): { id: string; keyHash: string } {
  const sufixo = Math.random().toString(36).slice(2, 10);
  const id = parcial?.id ?? `key_teste_${sufixo}`;
  const keyHash = parcial?.keyHash ?? `hash_teste_${sufixo}`;
  banco
    .prepare<[string, string, string, string]>(
      'INSERT INTO api_keys (id, nome, key_hash, ativa, criada_em, ultimo_uso_em) VALUES (?, ?, ?, 1, ?, NULL)',
    )
    .run(id, parcial?.nome ?? `Teste ${sufixo}`, keyHash, new Date().toISOString());
  return { id, keyHash };
}

export function criarExecucaoPendente(
  banco: Database.Database,
  parcial: { id: string; apiKeyId: string; tipo?: string },
): void {
  banco
    .prepare<[string, string, number]>(
      "INSERT INTO execucoes (id, tipo, status, payload, payload_bruto, resultado, error, attempts, api_key_id, ticket, cache_version, posicao_fila, criado_em, iniciado_em, finalizado_em, duracao_ms) VALUES (?, ?, 'PENDING', ?, ?, NULL, NULL, 0, ?, (SELECT COALESCE(MAX(ticket), 0) + 1 FROM execucoes), 1, NULL, ?, NULL, NULL, NULL)",
    )
    .run(
      parcial.id,
      parcial.tipo ?? 'sefaz-bahia',
      '{}',
      '{}',
      parcial.apiKeyId,
      new Date().toISOString(),
    );
}
